use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;

use adw::prelude::*;
use gtk::{Align, Orientation};
use zeroize::Zeroizing;

use crate::asset::{
    AssetStore, ImageAsset, MAX_IMAGES_PER_MESSAGE, inlay_tokens, without_inlay_tokens,
};
use crate::memory::{HypaV2State, HypaV3State, validate_memory_state};
use crate::model::{
    AppState, Character, CharacterProfile, HypaV3Settings, LoreEntry, LoreSettings, MemoryMode,
    Message, PresetSummary, ProviderKind, ProviderSettings, Role,
};
use crate::provider::{
    ChatService, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_BASE_URL, DEFAULT_CONTEXT_TOKENS,
    DEFAULT_EMBEDDING_MODEL, DEFAULT_GEMINI_BASE_URL, DEFAULT_MEMORY_ALLOCATED_TOKENS,
    DEFAULT_MEMORY_CHUNK_TOKENS, DEFAULT_OUTPUT_TOKENS, PreparedChat, ProviderEvent,
    RequestCancellation, validate_settings,
};
use crate::secret::{SecretError, SecretStore};
use crate::storage::Repository;

type SharedChatService = Rc<RefCell<Option<Rc<ChatService>>>>;

#[derive(Clone)]
struct ProviderServices {
    settings: Rc<RefCell<Option<ProviderSettings>>>,
    chat_service: SharedChatService,
    secret_store: Option<Rc<SecretStore>>,
    repository: Option<Rc<RefCell<Repository>>>,
    presets: Rc<Vec<PresetSummary>>,
    toast_overlay: adw::ToastOverlay,
    model_button: gtk::Button,
    subtitle: gtk::Label,
}

struct ContentServices {
    state: Rc<RefCell<AppState>>,
    repository: Option<Rc<RefCell<Repository>>>,
    asset_store: Option<Rc<AssetStore>>,
    provider: ProviderServices,
    toast_overlay: adw::ToastOverlay,
    character_list: gtk::ListBox,
    character_rows: CharacterRows,
    is_sending: Rc<Cell<bool>>,
}

type CharacterRows = Rc<RefCell<Vec<(gtk::ListBoxRow, String)>>>;

#[derive(Clone)]
struct PendingImage {
    id: String,
    path: PathBuf,
    name: String,
}

impl PendingImage {
    fn from_import(path: &std::path::Path, image: ImageAsset) -> Self {
        Self {
            id: image.id,
            path: image.path,
            name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("image")
                .to_owned(),
        }
    }
}

#[derive(Clone, Debug)]
enum GenerationKind {
    Append,
    Continue { message_id: String, prefix: String },
    Regenerate { user_message_id: String },
}

#[derive(Clone)]
struct GenerationController {
    state: Rc<RefCell<AppState>>,
    repository: Option<Rc<RefCell<Repository>>>,
    chat_service: SharedChatService,
    message_list: gtk::ListBox,
    adjustment: gtk::Adjustment,
    toast_overlay: adw::ToastOverlay,
    input: gtk::TextView,
    attach_button: gtk::Button,
    cleanup_button: gtk::Button,
    send_button: gtk::Button,
    stop_button: gtk::Button,
    continue_button: gtk::Button,
    regenerate_button: gtk::Button,
    is_sending: Rc<Cell<bool>>,
    cancel_requested: Rc<Cell<bool>>,
    cancellation: Rc<RefCell<Option<RequestCancellation>>>,
}

impl GenerationController {
    fn start(self: &Rc<Self>, requested_kind: Option<GenerationKind>) {
        if self.is_sending.get() {
            return;
        }
        let Some(repository) = self.repository.clone() else {
            self.toast_overlay.add_toast(adw::Toast::new(
                "SQLite가 연결되지 않아 AI 응답을 저장할 수 없습니다.",
            ));
            return;
        };
        let Some(chat_service) = self.chat_service.borrow().clone() else {
            self.toast_overlay
                .add_toast(adw::Toast::new("AI 공급자가 설정되지 않았습니다."));
            return;
        };
        let Some(mut character) = self.state.borrow().selected_character().cloned() else {
            self.toast_overlay
                .add_toast(adw::Toast::new("선택된 캐릭터가 없습니다."));
            return;
        };
        let Some(chat_id) = character.chat_id.clone() else {
            self.toast_overlay
                .add_toast(adw::Toast::new("활성 채팅이 없습니다."));
            return;
        };
        let kind = match requested_kind {
            Some(kind) => kind,
            None => GenerationKind::Append,
        };
        let visible_messages = match &kind {
            GenerationKind::Append => character.messages.clone(),
            GenerationKind::Continue { message_id, .. } => {
                let Some(last) = character.messages.last() else {
                    self.toast_overlay
                        .add_toast(adw::Toast::new("계속할 캐릭터 응답이 없습니다."));
                    return;
                };
                if last.role != Role::Character || last.id != *message_id {
                    self.toast_overlay.add_toast(adw::Toast::new(
                        "마지막 캐릭터 응답만 이어서 생성할 수 있습니다.",
                    ));
                    return;
                }
                character.messages[..character.messages.len() - 1].to_vec()
            }
            GenerationKind::Regenerate { user_message_id } => {
                let Some(anchor) = character.messages.iter().rposition(|message| {
                    message.id == *user_message_id && message.role == Role::User
                }) else {
                    self.toast_overlay
                        .add_toast(adw::Toast::new("재생성할 사용자 턴이 없습니다."));
                    return;
                };
                if !character.messages[anchor + 1..]
                    .iter()
                    .any(|message| message.role == Role::Character)
                {
                    self.toast_overlay
                        .add_toast(adw::Toast::new("재생성할 캐릭터 응답이 없습니다."));
                    return;
                }
                character.messages.truncate(anchor + 1);
                character.messages.clone()
            }
        };
        render_messages(&self.message_list, &visible_messages);

        let pending_content = match &kind {
            GenerationKind::Continue { prefix, .. } => prefix.clone(),
            _ => "…".to_owned(),
        };
        let pending = Message {
            id: String::new(),
            role: Role::Character,
            content: pending_content,
        };
        let (response_row, response_label) = build_message_row_with_body(&pending);
        if !matches!(kind, GenerationKind::Continue { .. }) {
            response_label.add_css_class("dim-label");
        }
        self.message_list.append(&response_row);
        scroll_to_bottom(&self.adjustment);

        self.set_busy(true);
        self.cancel_requested.set(false);
        let original_character = self
            .state
            .borrow()
            .characters
            .iter()
            .find(|candidate| candidate.id == character.id)
            .cloned()
            .unwrap_or_else(|| character.clone());
        let preparation = chat_service.prepare_character(character);
        *self.cancellation.borrow_mut() = Some(preparation.cancellation());
        let controller = Rc::clone(self);
        gtk::glib::MainContext::default().spawn_local(async move {
            let prepared = match preparation.recv().await {
                Ok(Ok(prepared)) => {
                    if controller.cancel_requested.get() {
                        controller.restore_after_cancel(&original_character, &chat_id);
                        controller.finish();
                        return;
                    }
                    prepared
                }
                Ok(Err(error)) => {
                    controller.restore_target(&original_character.id, &chat_id);
                    controller.toast_overlay.add_toast(adw::Toast::new(&format!(
                        "AI 요청 준비에 실패했습니다: {error}"
                    )));
                    controller.finish();
                    return;
                }
                Err(_) if controller.cancel_requested.get() => {
                    controller.restore_after_cancel(&original_character, &chat_id);
                    controller.finish();
                    return;
                }
                Err(_) => {
                    controller.restore_target(&original_character.id, &chat_id);
                    controller.toast_overlay.add_toast(adw::Toast::new(
                        "AI 요청 준비 작업이 예기치 않게 중단되었습니다.",
                    ));
                    controller.finish();
                    return;
                }
            };
            if let Err(error) = save_prepared_memory(
                &repository,
                &controller.state,
                &original_character,
                &chat_id,
                &prepared,
            ) {
                controller.restore_target(&original_character.id, &chat_id);
                controller.toast_overlay.add_toast(adw::Toast::new(&error));
                controller.finish();
                return;
            }

            let run = chat_service.start(prepared.messages);
            *controller.cancellation.borrow_mut() = Some(run.cancellation());
            if controller.cancel_requested.get() {
                if let Some(cancellation) = controller.cancellation.borrow().as_ref() {
                    cancellation.cancel();
                }
            }
            let mut response = String::new();
            let terminal = loop {
                match run.recv().await {
                    Ok(ProviderEvent::Delta(delta)) => {
                        response.push_str(&delta);
                        response_label.remove_css_class("dim-label");
                        response_label.set_visible(true);
                        let displayed = match &kind {
                            GenerationKind::Continue { prefix, .. } => {
                                without_inlay_tokens(&format!("{prefix}{response}"))
                            }
                            _ => without_inlay_tokens(&response),
                        };
                        response_label.set_label(&displayed);
                        scroll_to_bottom(&controller.adjustment);
                    }
                    Ok(ProviderEvent::Finished) if controller.cancel_requested.get() => {
                        break GenerationTerminal::Cancelled;
                    }
                    Ok(ProviderEvent::Finished) => break GenerationTerminal::Finished,
                    Ok(ProviderEvent::Failed(_)) if controller.cancel_requested.get() => {
                        break GenerationTerminal::Cancelled;
                    }
                    Ok(ProviderEvent::Failed(error)) => {
                        break GenerationTerminal::Failed(error);
                    }
                    Err(_) if controller.cancel_requested.get() => {
                        break GenerationTerminal::Cancelled;
                    }
                    Err(_) => break GenerationTerminal::Interrupted,
                }
            };
            controller.complete_response(
                &repository,
                &original_character.id,
                &chat_id,
                &kind,
                &response,
                terminal,
            );
            controller.finish();
        });
    }

    fn start_continue(self: &Rc<Self>) {
        let kind = self
            .state
            .borrow()
            .selected_character()
            .and_then(|character| character.messages.last())
            .filter(|message| message.role == Role::Character)
            .map(|message| GenerationKind::Continue {
                message_id: message.id.clone(),
                prefix: message.content.clone(),
            });
        let Some(kind) = kind else {
            self.toast_overlay
                .add_toast(adw::Toast::new("계속할 캐릭터 응답이 없습니다."));
            return;
        };
        self.start(Some(kind));
    }

    fn start_regenerate(self: &Rc<Self>) {
        let kind = self
            .state
            .borrow()
            .selected_character()
            .and_then(|character| {
                character
                    .messages
                    .iter()
                    .rfind(|message| message.role == Role::User)
            })
            .map(|message| GenerationKind::Regenerate {
                user_message_id: message.id.clone(),
            });
        let Some(kind) = kind else {
            self.toast_overlay
                .add_toast(adw::Toast::new("재생성할 사용자 턴이 없습니다."));
            return;
        };
        self.start(Some(kind));
    }

    fn cancel(&self) {
        if !self.is_sending.get() || self.cancel_requested.replace(true) {
            return;
        }
        self.stop_button.set_sensitive(false);
        if let Some(cancellation) = self.cancellation.borrow().as_ref() {
            cancellation.cancel();
        }
    }

    fn complete_response(
        &self,
        repository: &Rc<RefCell<Repository>>,
        character_id: &str,
        chat_id: &str,
        kind: &GenerationKind,
        response: &str,
        terminal: GenerationTerminal,
    ) {
        let has_response = !response.trim().is_empty();
        let should_persist = should_persist_generated_response(kind, &terminal, response);
        if should_persist {
            if let Err(error) = persist_generated_response(
                repository,
                &self.state,
                character_id,
                chat_id,
                kind,
                response,
            ) {
                self.restore_target(character_id, chat_id);
                self.toast_overlay.add_toast(adw::Toast::new(&format!(
                    "응답을 SQLite에 저장하지 못했습니다: {error}"
                )));
                return;
            }
        }
        self.restore_target(character_id, chat_id);
        match terminal {
            GenerationTerminal::Finished if !has_response => self
                .toast_overlay
                .add_toast(adw::Toast::new("공급자가 빈 응답을 반환했습니다.")),
            GenerationTerminal::Finished => {}
            GenerationTerminal::Cancelled => {
                self.toast_overlay
                    .add_toast(adw::Toast::new(if should_persist {
                        "생성을 중단했고 받은 부분 응답을 저장했습니다."
                    } else {
                        "생성을 중단했습니다."
                    }))
            }
            GenerationTerminal::Failed(error) => {
                self.toast_overlay.add_toast(adw::Toast::new(&format!(
                    "AI 요청에 실패했습니다{}: {error}",
                    if should_persist {
                        " (받은 부분 응답은 저장됨)"
                    } else {
                        ""
                    }
                )))
            }
            GenerationTerminal::Interrupted => {
                self.toast_overlay
                    .add_toast(adw::Toast::new(if should_persist {
                        "AI 요청 작업이 예기치 않게 중단되어 받은 부분 응답만 저장했습니다."
                    } else {
                        "AI 요청 작업이 예기치 않게 중단되었습니다."
                    }))
            }
        }
    }

    fn restore_after_cancel(&self, character: &Character, chat_id: &str) {
        self.restore_target(&character.id, chat_id);
        self.toast_overlay
            .add_toast(adw::Toast::new("생성을 중단했습니다."));
    }

    fn restore_target(&self, character_id: &str, chat_id: &str) {
        let state = self.state.borrow();
        let Some(character) = state.selected_character() else {
            return;
        };
        if character.id == character_id && character.chat_id.as_deref() == Some(chat_id) {
            render_messages(&self.message_list, &character.messages);
            scroll_to_bottom(&self.adjustment);
        }
    }

    fn set_busy(&self, busy: bool) {
        self.is_sending.set(busy);
        self.attach_button.set_sensitive(!busy);
        self.cleanup_button.set_sensitive(!busy);
        self.send_button.set_sensitive(!busy);
        self.continue_button.set_sensitive(!busy);
        self.regenerate_button.set_sensitive(!busy);
        self.input.set_sensitive(!busy);
        self.stop_button.set_visible(busy);
        self.stop_button.set_sensitive(busy);
    }

    fn finish(&self) {
        self.cancellation.borrow_mut().take();
        self.set_busy(false);
        self.cancel_requested.set(false);
        self.input.grab_focus();
    }
}

enum GenerationTerminal {
    Finished,
    Cancelled,
    Failed(String),
    Interrupted,
}

fn should_persist_generated_response(
    kind: &GenerationKind,
    terminal: &GenerationTerminal,
    response: &str,
) -> bool {
    if response.trim().is_empty() {
        return false;
    }
    match terminal {
        GenerationTerminal::Finished => true,
        GenerationTerminal::Cancelled
        | GenerationTerminal::Failed(_)
        | GenerationTerminal::Interrupted => !matches!(kind, GenerationKind::Regenerate { .. }),
    }
}

fn save_prepared_memory(
    repository: &Rc<RefCell<Repository>>,
    state: &Rc<RefCell<AppState>>,
    original: &Character,
    chat_id: &str,
    prepared: &PreparedChat,
) -> Result<(), String> {
    if prepared.supa_memory_data != original.supa_memory_data {
        repository
            .borrow_mut()
            .save_supa_memory(&original.id, chat_id, prepared.supa_memory_data.as_deref())
            .map_err(|error| {
                format!("SupaMemory 저장에 실패해 AI 요청을 보내지 않았습니다: {error}")
            })?;
        let _ = state.borrow_mut().update_supa_memory(
            &original.id,
            chat_id,
            prepared.supa_memory_data.clone(),
        );
    }
    if prepared.hypa_v2_data != original.hypa_v2_data {
        repository
            .borrow_mut()
            .save_hypa_v2_memory(&original.id, chat_id, prepared.hypa_v2_data.as_ref())
            .map_err(|error| {
                format!("HypaMemory V2 저장에 실패해 AI 요청을 보내지 않았습니다: {error}")
            })?;
        let _ = state.borrow_mut().update_hypa_v2_memory(
            &original.id,
            chat_id,
            prepared.hypa_v2_data.clone(),
        );
    }
    if prepared.hypa_v3_data != original.hypa_v3_data {
        repository
            .borrow_mut()
            .save_hypa_v3_memory(&original.id, chat_id, prepared.hypa_v3_data.as_ref())
            .map_err(|error| {
                format!("HypaMemory V3 저장에 실패해 AI 요청을 보내지 않았습니다: {error}")
            })?;
        let _ = state.borrow_mut().update_hypa_v3_memory(
            &original.id,
            chat_id,
            prepared.hypa_v3_data.clone(),
        );
    }
    Ok(())
}

fn persist_generated_response(
    repository: &Rc<RefCell<Repository>>,
    state: &Rc<RefCell<AppState>>,
    character_id: &str,
    chat_id: &str,
    kind: &GenerationKind,
    response: &str,
) -> Result<(), String> {
    match kind {
        GenerationKind::Append => {
            let stored = repository
                .borrow_mut()
                .append_character_message(character_id, Some(chat_id), response)
                .map_err(|error| error.to_string())?;
            let _ = state
                .borrow_mut()
                .append_message(character_id, stored.chat_id, stored.message);
        }
        GenerationKind::Continue { message_id, prefix } => {
            let content = format!("{prefix}{response}");
            let stored = repository
                .borrow_mut()
                .extend_last_character_message(character_id, chat_id, message_id, &content)
                .map_err(|error| error.to_string())?;
            let _ = state
                .borrow_mut()
                .update_message(character_id, chat_id, stored.message);
        }
        GenerationKind::Regenerate { user_message_id } => {
            let replaced = repository
                .borrow_mut()
                .replace_tail_after_user(character_id, chat_id, user_message_id, response)
                .map_err(|error| error.to_string())?;
            let _ = state.borrow_mut().replace_tail_after(
                character_id,
                chat_id,
                user_message_id,
                replaced.removed_count,
                replaced.stored.message,
            );
        }
    }
    Ok(())
}

pub fn build(application: &adw::Application) {
    install_css();

    let (initial_state, repository, startup_error, storage_tooltip) =
        match Repository::open_default().and_then(|repository| {
            let characters = repository.load_characters()?;
            let personas = repository.load_personas()?;
            let selected_persona = repository.load_selected_persona_index()?;
            let path = repository.path().display().to_string();
            Ok((
                AppState::from_characters(characters, personas, selected_persona),
                repository,
                path,
            ))
        }) {
            Ok((state, repository, path)) => (
                state,
                Some(Rc::new(RefCell::new(repository))),
                None,
                Some(path),
            ),
            Err(error) => (AppState::demo(), None, Some(error.to_string()), None),
        };
    let state = Rc::new(RefCell::new(initial_state));
    let (asset_store, asset_startup_error) = match AssetStore::open_default() {
        Ok(store) => (Some(Rc::new(store)), None),
        Err(error) => (None, Some(error.to_string())),
    };
    let mut provider_startup_errors = Vec::new();
    let saved_settings = repository.as_ref().and_then(|repository| {
        match repository.borrow().load_provider_settings() {
            Ok(settings) => settings,
            Err(error) => {
                provider_startup_errors.push(error.to_string());
                None
            }
        }
    });
    let presets = repository
        .as_ref()
        .map(|repository| repository.borrow().list_preset_summaries())
        .transpose()
        .unwrap_or_else(|error| {
            provider_startup_errors.push(error.to_string());
            Some(Vec::new())
        })
        .unwrap_or_default();
    let secret_store = match SecretStore::desktop() {
        Ok(store) => Some(Rc::new(store)),
        Err(error) => {
            provider_startup_errors.push(error.to_string());
            None
        }
    };
    let deferred_settings = saved_settings
        .as_ref()
        .filter(|settings| settings.credential_id.is_some())
        .cloned();
    let initial_chat_service = if let Some(settings) = &saved_settings {
        if settings.credential_id.is_some() {
            None
        } else {
            match ChatService::from_settings(settings, None) {
                Ok(service) => Some(Rc::new(service)),
                Err(error) => {
                    provider_startup_errors.push(error.to_string());
                    None
                }
            }
        }
    } else {
        match ChatService::from_environment() {
            Ok(service) => service.map(Rc::new),
            Err(error) => {
                provider_startup_errors.push(error.to_string());
                None
            }
        }
    };
    let chat_service = Rc::new(RefCell::new(initial_chat_service));
    let toast_overlay = adw::ToastOverlay::new();
    let shell = gtk::Paned::new(Orientation::Horizontal);
    shell.add_css_class("app-shell");
    toast_overlay.set_child(Some(&shell));

    let character_list = gtk::ListBox::new();
    character_list.set_selection_mode(gtk::SelectionMode::Single);
    character_list.add_css_class("navigation-sidebar");

    let title = gtk::Label::new(None);
    title.add_css_class("title");
    title.set_ellipsize(gtk::pango::EllipsizeMode::End);

    let initial_model = chat_service
        .borrow()
        .as_ref()
        .map(|service| service.model().to_owned())
        .or_else(|| {
            deferred_settings
                .as_ref()
                .map(|settings| settings.model.clone())
        });
    let subtitle = gtk::Label::new(Some(
        initial_model
            .as_deref()
            .unwrap_or("AI provider not configured"),
    ));
    subtitle.add_css_class("subtitle");
    subtitle.add_css_class("dim-label");
    let model_button = gtk::Button::builder()
        .label(initial_model.as_deref().unwrap_or("Model"))
        .tooltip_text("AI 공급자 설정")
        .css_classes(["flat"])
        .build();
    let provider = ProviderServices {
        settings: Rc::new(RefCell::new(saved_settings)),
        chat_service: Rc::clone(&chat_service),
        secret_store,
        repository: repository.clone(),
        presets: Rc::new(presets),
        toast_overlay: toast_overlay.clone(),
        model_button,
        subtitle: subtitle.clone(),
    };

    let character_rows = build_character_rows(&state.borrow(), &character_list);
    let sidebar = build_sidebar(
        &character_list,
        &character_rows,
        &toast_overlay,
        storage_tooltip.as_deref(),
        Rc::clone(&state),
        repository.clone(),
        provider.clone(),
    );

    let message_list = gtk::ListBox::new();
    message_list.set_selection_mode(gtk::SelectionMode::None);
    message_list.add_css_class("message-list");

    let input = gtk::TextView::new();
    input.set_wrap_mode(gtk::WrapMode::WordChar);
    input.set_top_margin(10);
    input.set_bottom_margin(10);
    input.set_left_margin(12);
    input.set_right_margin(12);
    input.set_accepts_tab(false);
    input.set_vexpand(false);
    input.add_css_class("composer-input");

    let is_sending = Rc::new(Cell::new(false));
    let content = build_content(
        &title,
        &subtitle,
        &message_list,
        &input,
        ContentServices {
            state: Rc::clone(&state),
            repository: repository.clone(),
            asset_store: asset_store.clone(),
            provider: provider.clone(),
            toast_overlay: toast_overlay.clone(),
            character_list: character_list.clone(),
            character_rows: Rc::clone(&character_rows),
            is_sending: Rc::clone(&is_sending),
        },
    );

    shell.set_start_child(Some(&sidebar));
    shell.set_end_child(Some(&content));
    shell.set_position(320);
    shell.set_resize_start_child(false);
    shell.set_shrink_start_child(false);
    shell.set_wide_handle(true);

    let window = adw::ApplicationWindow::builder()
        .application(application)
        .title("RisuAI Native")
        .default_width(1180)
        .default_height(760)
        .content(&toast_overlay)
        .build();
    window.set_size_request(760, 520);

    {
        let state = Rc::clone(&state);
        let title = title.clone();
        let message_list = message_list.clone();
        character_list.connect_row_selected(move |_, row| {
            let Some(row) = row else {
                return;
            };
            let index = row.index() as usize;
            if !state.borrow_mut().select(index) {
                return;
            }

            let state = state.borrow();
            let Some(character) = state.selected_character() else {
                return;
            };
            title.set_label(&character.name);
            render_messages(&message_list, &character.messages);
        });
    }

    {
        let state = Rc::clone(&state);
        let repository = repository.clone();
        let toast_overlay = toast_overlay.clone();
        let message_list = message_list.clone();
        let message_list_for_callback = message_list.clone();
        let is_sending = Rc::clone(&is_sending);
        message_list.connect_row_activated(move |_, row| {
            if is_sending.get() {
                toast_overlay.add_toast(adw::Toast::new(
                    "응답 생성이 끝난 뒤 메시지를 편집할 수 있습니다.",
                ));
                return;
            }
            let index = row.index().max(0) as usize;
            let selected = state.borrow().selected_character().and_then(|character| {
                Some((
                    character.id.clone(),
                    character.chat_id.clone()?,
                    character.messages.get(index)?.clone(),
                ))
            });
            let Some((character_id, chat_id, message)) = selected else {
                return;
            };
            if message.id.starts_with("virtual-first-message:") {
                toast_overlay.add_toast(adw::Toast::new(
                    "첫 메시지는 캐릭터 프로필 편집에서 변경해 주세요.",
                ));
                return;
            }
            show_message_editor(
                &toast_overlay,
                &state,
                repository.as_ref(),
                &message_list_for_callback,
                &character_id,
                &chat_id,
                &message,
            );
        });
    }

    let selected_index = state.borrow().selected_index();
    if let Some(index) = selected_index
        && let Some(row) = character_list.row_at_index(index as i32)
    {
        character_list.select_row(Some(&row));
    }

    window.present();
    if let Some(error) = startup_error {
        toast_overlay.add_toast(adw::Toast::new(&format!(
            "SQLite를 열지 못해 메모리 모드로 시작했습니다: {error}"
        )));
    }
    if let Some(error) = asset_startup_error {
        toast_overlay.add_toast(adw::Toast::new(&format!(
            "첨부 이미지 저장소를 열지 못했습니다: {error}"
        )));
    }
    for error in provider_startup_errors {
        toast_overlay.add_toast(adw::Toast::new(&format!(
            "AI 공급자 설정을 사용할 수 없습니다: {error}"
        )));
    }
    if let Some(settings) = deferred_settings {
        initialize_saved_provider(provider, settings);
    }
}

fn show_persona_editor(
    toast_overlay: &adw::ToastOverlay,
    state: &Rc<RefCell<AppState>>,
    repository: Option<&Rc<RefCell<Repository>>>,
) {
    let Some(window) = toast_overlay.root().and_downcast::<gtk::Window>() else {
        return;
    };
    let (personas, selected_index, character_id, chat_id, is_bound) = {
        let state = state.borrow();
        let Some(character) = state.selected_character() else {
            toast_overlay.add_toast(adw::Toast::new("페르소나를 적용할 캐릭터가 없습니다."));
            return;
        };
        let selected = character
            .bound_persona_id
            .as_deref()
            .and_then(|id| {
                state
                    .personas
                    .iter()
                    .position(|persona| persona.id.as_deref() == Some(id))
            })
            .unwrap_or(
                state
                    .selected_persona
                    .min(state.personas.len().saturating_sub(1)),
            );
        (
            state.personas.clone(),
            selected,
            character.id.clone(),
            character.chat_id.clone(),
            character.bound_persona_id.is_some(),
        )
    };
    let Some(chat_id) = chat_id else {
        toast_overlay.add_toast(adw::Toast::new("활성 채팅이 없습니다."));
        return;
    };
    if personas.is_empty() {
        toast_overlay.add_toast(adw::Toast::new("저장된 페르소나가 없습니다."));
        return;
    }
    let dialog = gtk::Dialog::builder()
        .title("사용자 페르소나")
        .transient_for(&window)
        .modal(true)
        .default_width(620)
        .default_height(560)
        .build();
    dialog.add_button("취소", gtk::ResponseType::Cancel);
    dialog.add_button("저장", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Accept);
    let form = gtk::Box::new(Orientation::Vertical, 10);
    form.set_margin_top(16);
    form.set_margin_bottom(16);
    form.set_margin_start(16);
    form.set_margin_end(16);
    let names = personas
        .iter()
        .map(|persona| persona.name.as_str())
        .collect::<Vec<_>>();
    let selector = gtk::DropDown::from_strings(&names);
    selector.set_selected(selected_index as u32);
    form.append(&gtk::Label::builder().label("페르소나").xalign(0.0).build());
    form.append(&selector);
    let bind_to_chat = gtk::CheckButton::with_label("현재 채팅에 이 페르소나 고정");
    bind_to_chat.set_active(is_bound);
    form.append(&bind_to_chat);
    let name = gtk::Entry::builder()
        .text(&personas[selected_index].name)
        .build();
    form.append(
        &gtk::Label::builder()
            .label("사용자 이름")
            .xalign(0.0)
            .build(),
    );
    form.append(&name);
    let prompt = append_profile_field(
        &form,
        "페르소나 설명 (모델 프롬프트)",
        &personas[selected_index].prompt,
        150,
    );
    let note = append_profile_field(
        &form,
        "사용자 메모 (모델에는 보내지 않음)",
        &personas[selected_index].note,
        90,
    );
    let hint = gtk::Label::new(Some(
        "목록을 바꾸면 해당 페르소나의 저장된 값으로 편집기가 전환됩니다.",
    ));
    hint.set_xalign(0.0);
    hint.add_css_class("dim-label");
    form.append(&hint);
    dialog.content_area().append(&form);

    {
        let personas = personas.clone();
        let name = name.clone();
        let prompt = prompt.clone();
        let note = note.clone();
        selector.connect_selected_notify(move |selector| {
            let index = selector.selected() as usize;
            let Some(persona) = personas.get(index) else {
                return;
            };
            name.set_text(&persona.name);
            prompt.buffer().set_text(&persona.prompt);
            note.buffer().set_text(&persona.note);
        });
    }
    let toast_overlay = toast_overlay.clone();
    let state = Rc::clone(state);
    let repository = repository.cloned();
    dialog.connect_response(move |dialog, response| {
        if response != gtk::ResponseType::Accept {
            dialog.close();
            return;
        }
        let Some(repository) = &repository else {
            toast_overlay.add_toast(adw::Toast::new(
                "SQLite가 연결되지 않아 페르소나를 저장할 수 없습니다.",
            ));
            return;
        };
        let selected = selector.selected() as usize;
        let mut updated = personas.clone();
        let Some(persona) = updated.get_mut(selected) else {
            return;
        };
        persona.name = name.text().trim().to_owned();
        persona.prompt = text_view_text(&prompt);
        persona.note = text_view_text(&note);
        match repository.borrow_mut().save_personas(
            &updated,
            selected,
            &character_id,
            &chat_id,
            bind_to_chat.is_active(),
        ) {
            Ok(saved) => {
                let _ = state.borrow_mut().update_personas(
                    saved.personas,
                    saved.selected_index,
                    &character_id,
                    &chat_id,
                    saved.bound_persona_id,
                );
                dialog.close();
                toast_overlay.add_toast(adw::Toast::new("페르소나를 저장했습니다."));
            }
            Err(error) => toast_overlay.add_toast(adw::Toast::new(&format!(
                "페르소나를 저장하지 못했습니다: {error}"
            ))),
        }
    });
    dialog.present();
}

fn show_message_editor(
    toast_overlay: &adw::ToastOverlay,
    state: &Rc<RefCell<AppState>>,
    repository: Option<&Rc<RefCell<Repository>>>,
    message_list: &gtk::ListBox,
    character_id: &str,
    chat_id: &str,
    message: &Message,
) {
    let Some(window) = toast_overlay.root().and_downcast::<gtk::Window>() else {
        return;
    };
    let dialog = gtk::Dialog::builder()
        .title("메시지 편집")
        .transient_for(&window)
        .modal(true)
        .default_width(640)
        .default_height(430)
        .build();
    dialog.add_button("취소", gtk::ResponseType::Cancel);
    dialog.add_button("여기부터 삭제", gtk::ResponseType::Other(1));
    dialog.add_button("이 메시지만 삭제", gtk::ResponseType::Reject);
    dialog.add_button("저장", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Accept);

    let content = gtk::Box::new(Orientation::Vertical, 10);
    content.set_margin_top(16);
    content.set_margin_bottom(16);
    content.set_margin_start(16);
    content.set_margin_end(16);
    let hint = gtk::Label::new(Some(
        "첨부 이미지는 {{inlayed::UUID}} 토큰으로 저장됩니다. 토큰을 지우면 메시지의 참조만 제거됩니다.",
    ));
    hint.set_xalign(0.0);
    hint.set_wrap(true);
    hint.add_css_class("dim-label");
    content.append(&hint);
    let editor = gtk::TextView::new();
    editor.set_wrap_mode(gtk::WrapMode::WordChar);
    editor.buffer().set_text(&message.content);
    editor.set_top_margin(10);
    editor.set_bottom_margin(10);
    editor.set_left_margin(10);
    editor.set_right_margin(10);
    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .child(&editor)
        .build();
    scroller.add_css_class("profile-editor");
    content.append(&scroller);
    dialog.content_area().append(&content);
    editor.grab_focus();

    let toast_overlay = toast_overlay.clone();
    let state = Rc::clone(state);
    let repository = repository.cloned();
    let message_list = message_list.clone();
    let character_id = character_id.to_owned();
    let chat_id = chat_id.to_owned();
    let message_id = message.id.clone();
    dialog.connect_response(move |dialog, response| match response {
        gtk::ResponseType::Accept => {
            let Some(repository) = &repository else {
                toast_overlay.add_toast(adw::Toast::new(
                    "SQLite가 연결되지 않아 메시지를 편집할 수 없습니다.",
                ));
                return;
            };
            let content = text_view_text(&editor);
            match repository.borrow_mut().update_message_content(
                &character_id,
                &chat_id,
                &message_id,
                &content,
            ) {
                Ok(stored) => {
                    let _ = state.borrow_mut().update_message(
                        &character_id,
                        &chat_id,
                        stored.message,
                    );
                    render_target_messages(&state, &message_list, &character_id, &chat_id);
                    dialog.close();
                    toast_overlay.add_toast(adw::Toast::new("메시지를 저장했습니다."));
                }
                Err(error) => toast_overlay.add_toast(adw::Toast::new(&format!(
                    "메시지를 편집하지 못했습니다: {error}"
                ))),
            }
        }
        gtk::ResponseType::Reject | gtk::ResponseType::Other(1) => {
            let delete_tail = response == gtk::ResponseType::Other(1);
            let confirmation = adw::AlertDialog::builder()
                .heading(if delete_tail {
                    "이 메시지부터 끝까지 삭제할까요?"
                } else {
                    "이 메시지만 삭제할까요?"
                })
                .body("메시지 확장 데이터도 함께 삭제되며 되돌릴 수 없습니다. 메모리 체크포인트는 같은 트랜잭션에서 정리됩니다.")
                .build();
            confirmation.add_response("cancel", "취소");
            confirmation.add_response("delete", "삭제");
            confirmation.set_close_response("cancel");
            confirmation.set_response_appearance(
                "delete",
                adw::ResponseAppearance::Destructive,
            );
            let state = Rc::clone(&state);
            let repository = repository.clone();
            let toast_overlay = toast_overlay.clone();
            let message_list = message_list.clone();
            let character_id = character_id.clone();
            let chat_id = chat_id.clone();
            let message_id = message_id.clone();
            let editor_dialog = dialog.clone();
            confirmation.connect_response(Some("delete"), move |_, _| {
                let Some(repository) = &repository else {
                    toast_overlay.add_toast(adw::Toast::new(
                        "SQLite가 연결되지 않아 메시지를 삭제할 수 없습니다.",
                    ));
                    return;
                };
                match repository.borrow_mut().delete_message_range(
                    &character_id,
                    &chat_id,
                    &message_id,
                    delete_tail,
                ) {
                    Ok(deleted) => {
                        let ids = deleted
                            .messages
                            .iter()
                            .map(|message| message.id.clone())
                            .collect::<Vec<_>>();
                        let _ = state.borrow_mut().delete_messages(
                            &character_id,
                            &chat_id,
                            &ids,
                            deleted.supa_memory_data,
                            deleted.hypa_v2_data,
                            deleted.hypa_v3_data,
                        );
                        render_target_messages(
                            &state,
                            &message_list,
                            &character_id,
                            &chat_id,
                        );
                        editor_dialog.close();
                        toast_overlay.add_toast(adw::Toast::new(if delete_tail {
                            "선택한 메시지부터 마지막까지 삭제했습니다."
                        } else {
                            "메시지를 삭제했습니다."
                        }));
                    }
                    Err(error) => toast_overlay.add_toast(adw::Toast::new(&format!(
                        "메시지를 삭제하지 못했습니다: {error}"
                    ))),
                }
            });
            confirmation.present(Some(dialog));
        }
        _ => dialog.close(),
    });
    dialog.present();
}

fn render_target_messages(
    state: &Rc<RefCell<AppState>>,
    message_list: &gtk::ListBox,
    character_id: &str,
    chat_id: &str,
) {
    let state = state.borrow();
    let Some(character) = state.selected_character() else {
        return;
    };
    if character.id == character_id && character.chat_id.as_deref() == Some(chat_id) {
        render_messages(message_list, &character.messages);
    }
}

fn build_sidebar(
    character_list: &gtk::ListBox,
    character_rows: &CharacterRows,
    toast_overlay: &adw::ToastOverlay,
    storage_path: Option<&str>,
    state: Rc<RefCell<AppState>>,
    repository: Option<Rc<RefCell<Repository>>>,
    provider: ProviderServices,
) -> gtk::Box {
    let sidebar = gtk::Box::new(Orientation::Vertical, 0);
    sidebar.set_width_request(280);
    sidebar.add_css_class("sidebar");

    let header = adw::HeaderBar::new();
    header.set_title_widget(Some(
        &gtk::Label::builder()
            .label("RisuAI")
            .css_classes(["title"])
            .build(),
    ));

    let new_chat = icon_button("list-add-symbolic", "새 캐릭터 또는 그룹 만들기");
    let toast_overlay_for_new = toast_overlay.clone();
    let character_list_for_new = character_list.clone();
    let character_rows_for_new = Rc::clone(character_rows);
    new_chat.connect_clicked(move |_| {
        show_new_character_dialog(
            &toast_overlay_for_new,
            &state,
            repository.as_ref(),
            &character_list_for_new,
            &character_rows_for_new,
        );
    });
    header.pack_start(&new_chat);

    let settings = icon_button("preferences-system-symbolic", "설정 열기");
    settings.connect_clicked(move |_| {
        show_provider_settings(&provider);
    });
    header.pack_end(&settings);
    sidebar.append(&header);

    let search = gtk::SearchEntry::builder()
        .placeholder_text("캐릭터 검색")
        .margin_top(8)
        .margin_bottom(8)
        .margin_start(12)
        .margin_end(12)
        .build();
    search.set_key_capture_widget(Some(&sidebar));
    sidebar.append(&search);

    let rows = Rc::clone(character_rows);
    search.connect_search_changed(move |search| {
        let query = search.text().trim().to_lowercase();
        for (row, searchable_text) in rows.borrow().iter() {
            row.set_visible(query.is_empty() || searchable_text.contains(&query));
        }
    });

    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .child(character_list)
        .build();
    sidebar.append(&scroller);

    let footer = gtk::Box::new(Orientation::Horizontal, 8);
    footer.set_margin_top(10);
    footer.set_margin_bottom(10);
    footer.set_margin_start(14);
    footer.set_margin_end(14);
    footer.append(&gtk::Image::from_icon_name("network-wireless-symbolic"));
    let status = gtk::Label::new(Some(if storage_path.is_some() {
        "SQLite · Persistent"
    } else {
        "Memory · Offline"
    }));
    status.add_css_class("dim-label");
    status.set_xalign(0.0);
    status.set_tooltip_text(storage_path);
    footer.append(&status);
    sidebar.append(&footer);

    sidebar
}

fn build_content(
    title: &gtk::Label,
    subtitle: &gtk::Label,
    message_list: &gtk::ListBox,
    input: &gtk::TextView,
    services: ContentServices,
) -> gtk::Box {
    let ContentServices {
        state,
        repository,
        asset_store,
        provider,
        toast_overlay,
        character_list,
        character_rows,
        is_sending,
    } = services;
    let content = gtk::Box::new(Orientation::Vertical, 0);
    content.set_hexpand(true);
    content.add_css_class("content");

    let header = adw::HeaderBar::new();
    let heading = gtk::Box::new(Orientation::Vertical, 0);
    heading.set_halign(Align::Center);
    heading.append(title);
    heading.append(subtitle);
    header.set_title_widget(Some(&heading));

    let edit_character = icon_button("document-edit-symbolic", "캐릭터 프로필 편집");
    {
        let toast_overlay = toast_overlay.clone();
        let state = Rc::clone(&state);
        let repository = repository.clone();
        let character_list = character_list.clone();
        let character_rows = Rc::clone(&character_rows);
        let title = title.clone();
        let message_list = message_list.clone();
        edit_character.connect_clicked(move |_| {
            show_character_editor(
                &toast_overlay,
                &state,
                repository.as_ref(),
                &character_list,
                &character_rows,
                &title,
                &message_list,
            );
        });
    }
    header.pack_start(&edit_character);

    let manage_chats = icon_button("view-list-symbolic", "채팅 관리");
    {
        let toast_overlay = toast_overlay.clone();
        let state = Rc::clone(&state);
        let repository = repository.clone();
        let message_list = message_list.clone();
        manage_chats.connect_clicked(move |_| {
            show_chat_manager(&toast_overlay, &state, repository.as_ref(), &message_list);
        });
    }
    header.pack_start(&manage_chats);

    let edit_lorebooks = icon_button("document-properties-symbolic", "로어북 편집");
    {
        let toast_overlay = toast_overlay.clone();
        let state = Rc::clone(&state);
        let repository = repository.clone();
        edit_lorebooks.connect_clicked(move |_| {
            show_lorebook_editor(&toast_overlay, &state, repository.as_ref());
        });
    }
    header.pack_start(&edit_lorebooks);

    let edit_memory = icon_button("document-save-symbolic", "메모리 상태 편집");
    {
        let toast_overlay = toast_overlay.clone();
        let state = Rc::clone(&state);
        let repository = repository.clone();
        let provider = provider.clone();
        edit_memory.connect_clicked(move |_| {
            let memory_mode = provider
                .settings
                .borrow()
                .as_ref()
                .map(|settings| settings.memory_mode)
                .or_else(|| {
                    provider
                        .chat_service
                        .borrow()
                        .as_ref()
                        .map(|service| service.memory_mode())
                })
                .unwrap_or_default();
            show_memory_editor(&toast_overlay, &state, repository.as_ref(), memory_mode);
        });
    }
    header.pack_start(&edit_memory);

    let edit_persona = icon_button("avatar-default-symbolic", "사용자 페르소나 선택 및 편집");
    {
        let toast_overlay = toast_overlay.clone();
        let state = Rc::clone(&state);
        let repository = repository.clone();
        edit_persona.connect_clicked(move |_| {
            show_persona_editor(&toast_overlay, &state, repository.as_ref());
        });
    }
    header.pack_start(&edit_persona);

    let model_button = provider.model_button.clone();
    let provider_for_dialog = provider.clone();
    model_button.connect_clicked(move |_| {
        show_provider_settings(&provider_for_dialog);
    });
    header.pack_end(&model_button);
    content.append(&header);

    let messages_scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .child(message_list)
        .build();
    messages_scroller.add_css_class("messages-scroller");
    content.append(&messages_scroller);

    let composer = gtk::Box::new(Orientation::Vertical, 6);
    composer.set_margin_top(10);
    composer.set_margin_bottom(14);
    composer.set_margin_start(18);
    composer.set_margin_end(18);
    composer.add_css_class("composer");

    let pending_images = Rc::new(RefCell::new(Vec::<PendingImage>::new()));
    let pending_imports = Rc::new(Cell::new(0_usize));
    let attachment_preview = gtk::Box::new(Orientation::Horizontal, 8);
    let attachment_scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Automatic)
        .vscrollbar_policy(gtk::PolicyType::Never)
        .min_content_height(92)
        .child(&attachment_preview)
        .build();
    attachment_scroller.set_visible(false);
    composer.append(&attachment_scroller);

    let composer_controls = gtk::Box::new(Orientation::Horizontal, 6);
    composer_controls.set_valign(Align::End);

    let attach = icon_button("mail-attachment-symbolic", "이미지 첨부");
    let toast_overlay_for_attach = toast_overlay.clone();
    let pending_for_attach = Rc::clone(&pending_images);
    let preview_for_attach = attachment_preview.clone();
    let scroller_for_attach = attachment_scroller.clone();
    let asset_store_for_attach = asset_store.clone();
    let pending_imports_for_attach = Rc::clone(&pending_imports);
    attach.connect_clicked(move |_| {
        let Some(asset_store) = asset_store_for_attach.clone() else {
            toast_overlay_for_attach
                .add_toast(adw::Toast::new("첨부 이미지 저장소를 사용할 수 없습니다."));
            return;
        };
        let Some(window) = toast_overlay_for_attach
            .root()
            .and_downcast::<gtk::Window>()
        else {
            return;
        };
        let chooser = gtk::FileChooserNative::builder()
            .title("이미지 첨부")
            .transient_for(&window)
            .modal(true)
            .action(gtk::FileChooserAction::Open)
            .accept_label("첨부")
            .cancel_label("취소")
            .select_multiple(true)
            .build();
        let filter = gtk::FileFilter::new();
        filter.set_name(Some("이미지 (PNG, JPEG, GIF, WebP)"));
        for mime_type in [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
        ] {
            filter.add_mime_type(mime_type);
        }
        chooser.add_filter(&filter);

        let pending_images = Rc::clone(&pending_for_attach);
        let attachment_preview = preview_for_attach.clone();
        let attachment_scroller = scroller_for_attach.clone();
        let toast_overlay = toast_overlay_for_attach.clone();
        let pending_imports = Rc::clone(&pending_imports_for_attach);
        chooser.connect_response(move |chooser, response| {
            if response == gtk::ResponseType::Accept {
                let files = chooser.files();
                for index in 0..files.n_items() {
                    if pending_images.borrow().len() + pending_imports.get()
                        >= MAX_IMAGES_PER_MESSAGE
                    {
                        toast_overlay.add_toast(adw::Toast::new(&format!(
                            "한 메시지에는 이미지를 최대 {MAX_IMAGES_PER_MESSAGE}장까지 첨부할 수 있습니다."
                        )));
                        break;
                    }
                    let Some(file) = files.item(index).and_downcast::<gtk::gio::File>() else {
                        continue;
                    };
                    let Some(path) = file.path() else {
                        toast_overlay.add_toast(adw::Toast::new(
                            "로컬 파일로 접근할 수 있는 이미지만 첨부할 수 있습니다.",
                        ));
                        continue;
                    };
                    let (sender, receiver) = async_channel::bounded(1);
                    pending_imports.set(pending_imports.get().saturating_add(1));
                    let store = asset_store.as_ref().clone();
                    let import_path = path.clone();
                    std::thread::spawn(move || {
                        let _ = sender.send_blocking(store.import_image(&import_path));
                    });
                    let pending_images = Rc::clone(&pending_images);
                    let attachment_preview = attachment_preview.clone();
                    let attachment_scroller = attachment_scroller.clone();
                    let toast_overlay = toast_overlay.clone();
                    let asset_store = Rc::clone(&asset_store);
                    let pending_imports = Rc::clone(&pending_imports);
                    gtk::glib::MainContext::default().spawn_local(async move {
                        let result = receiver.recv().await;
                        pending_imports.set(pending_imports.get().saturating_sub(1));
                        match result {
                            Ok(Ok(image)) => {
                                pending_images
                                    .borrow_mut()
                                    .push(PendingImage::from_import(&path, image));
                                render_pending_images(
                                    &attachment_preview,
                                    &attachment_scroller,
                                    &pending_images,
                                    &asset_store,
                                    &toast_overlay,
                                );
                            }
                            Ok(Err(error)) => toast_overlay.add_toast(adw::Toast::new(&format!(
                                "이미지를 첨부하지 못했습니다: {error}"
                            ))),
                            Err(_) => toast_overlay
                                .add_toast(adw::Toast::new("이미지 첨부 작업이 중단되었습니다.")),
                        }
                    });
                }
            }
            chooser.hide();
        });
        chooser.show();
    });
    composer_controls.append(&attach);

    let cleanup = icon_button("edit-clear-all-symbolic", "참조되지 않은 첨부 이미지 정리");
    composer_controls.append(&cleanup);

    let input_scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .min_content_height(48)
        .max_content_height(160)
        .hexpand(true)
        .child(input)
        .build();
    input_scroller.add_css_class("composer-entry");
    composer_controls.append(&input_scroller);

    let continue_button = icon_button("media-seek-forward-symbolic", "마지막 응답 계속");
    composer_controls.append(&continue_button);
    let regenerate_button = icon_button("view-refresh-symbolic", "마지막 응답 재생성");
    composer_controls.append(&regenerate_button);
    let stop_button = gtk::Button::builder()
        .icon_name("process-stop-symbolic")
        .tooltip_text("생성 중단")
        .css_classes(["destructive-action", "circular"])
        .valign(Align::Center)
        .visible(false)
        .build();
    composer_controls.append(&stop_button);
    let send = gtk::Button::builder()
        .icon_name("mail-send-symbolic")
        .tooltip_text("메시지 보내기")
        .css_classes(["suggested-action", "circular"])
        .valign(Align::Center)
        .build();
    composer_controls.append(&send);
    composer.append(&composer_controls);
    content.append(&composer);

    let controller = Rc::new(GenerationController {
        state: Rc::clone(&state),
        repository: repository.clone(),
        chat_service: Rc::clone(&provider.chat_service),
        message_list: message_list.clone(),
        adjustment: messages_scroller.vadjustment(),
        toast_overlay: toast_overlay.clone(),
        input: input.clone(),
        attach_button: attach.clone(),
        cleanup_button: cleanup.clone(),
        send_button: send.clone(),
        stop_button: stop_button.clone(),
        continue_button: continue_button.clone(),
        regenerate_button: regenerate_button.clone(),
        is_sending,
        cancel_requested: Rc::new(Cell::new(false)),
        cancellation: Rc::new(RefCell::new(None)),
    });
    {
        let controller = Rc::clone(&controller);
        stop_button.connect_clicked(move |_| controller.cancel());
    }
    {
        let controller = Rc::clone(&controller);
        continue_button.connect_clicked(move |_| controller.start_continue());
    }
    {
        let controller = Rc::clone(&controller);
        regenerate_button.connect_clicked(move |_| controller.start_regenerate());
    }
    {
        let controller = Rc::clone(&controller);
        let repository = repository.clone();
        let asset_store = asset_store.clone();
        let pending_images = Rc::clone(&pending_images);
        let pending_imports = Rc::clone(&pending_imports);
        let toast_overlay = toast_overlay.clone();
        cleanup.connect_clicked(move |_| {
            if controller.is_sending.get() {
                return;
            }
            if pending_imports.get() != 0 {
                toast_overlay.add_toast(adw::Toast::new(
                    "이미지 가져오기가 끝난 뒤 첨부 저장소를 정리해 주세요.",
                ));
                return;
            }
            let Some(repository) = repository.clone() else {
                toast_overlay.add_toast(adw::Toast::new(
                    "SQLite가 연결되지 않아 첨부 참조를 확인할 수 없습니다.",
                ));
                return;
            };
            let Some(asset_store) = asset_store.clone() else {
                toast_overlay.add_toast(adw::Toast::new(
                    "첨부 이미지 저장소를 사용할 수 없습니다.",
                ));
                return;
            };
            let confirmation = adw::AlertDialog::builder()
                .heading("사용하지 않는 첨부 이미지를 정리할까요?")
                .body("모든 SQLite 메시지와 현재 작성 중인 첨부에서 참조하지 않는 네이티브 이미지 파일만 영구 삭제합니다.")
                .build();
            confirmation.add_response("cancel", "취소");
            confirmation.add_response("cleanup", "정리");
            confirmation.set_close_response("cancel");
            confirmation.set_response_appearance(
                "cleanup",
                adw::ResponseAppearance::Destructive,
            );
            let repository = Rc::clone(&repository);
            let asset_store = Rc::clone(&asset_store);
            let pending_images = Rc::clone(&pending_images);
            let parent = toast_overlay.root();
            let toast_overlay = toast_overlay.clone();
            confirmation.connect_response(Some("cleanup"), move |_, _| {
                let referenced = match repository.borrow().referenced_inlay_ids() {
                    Ok(referenced) => referenced,
                    Err(error) => {
                        toast_overlay.add_toast(adw::Toast::new(&format!(
                            "첨부 참조를 확인하지 못해 아무 파일도 삭제하지 않았습니다: {error}"
                        )));
                        return;
                    }
                };
                let protected = pending_images
                    .borrow()
                    .iter()
                    .map(|image| image.id.clone())
                    .collect::<std::collections::HashSet<_>>();
                match asset_store.cleanup_orphans(&referenced, &protected) {
                    Ok(report) => toast_overlay.add_toast(adw::Toast::new(&format!(
                        "사용하지 않는 첨부 {}개({:.1} KiB)를 정리했습니다.",
                        report.removed_files,
                        report.reclaimed_bytes as f64 / 1024.0
                    ))),
                    Err(error) => toast_overlay.add_toast(adw::Toast::new(&format!(
                        "첨부 저장소 정리를 완료하지 못했습니다: {error}"
                    ))),
                }
            });
            confirmation.present(parent.as_ref());
        });
    }
    {
        let controller = Rc::clone(&controller);
        let state = Rc::clone(&state);
        let repository = repository.clone();
        let pending_images = Rc::clone(&pending_images);
        let pending_imports = Rc::clone(&pending_imports);
        let attachment_preview = attachment_preview.clone();
        let attachment_scroller = attachment_scroller.clone();
        let asset_store = asset_store.clone();
        let toast_overlay = toast_overlay.clone();
        let input = input.clone();
        send.connect_clicked(move |_| {
            if controller.is_sending.get() {
                return;
            }
            if pending_imports.get() != 0 {
                toast_overlay.add_toast(adw::Toast::new(
                    "이미지를 저장하는 중입니다. 잠시 후 다시 보내 주세요.",
                ));
                return;
            }
            let buffer = input.buffer();
            let raw_content = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false);
            let mut content = raw_content.trim().to_owned();
            for image in pending_images.borrow().iter() {
                if !content.is_empty() {
                    content.push('\n');
                }
                content.push_str(&format!("{{{{inlayed::{}}}}}", image.id));
            }
            let draft = {
                let state = state.borrow();
                state.validate_message(&content).and_then(|content| {
                    state
                        .selected_character()
                        .map(|character| (character.id.clone(), character.chat_id.clone(), content))
                        .ok_or(crate::model::SubmitError::NoCharacterSelected)
                })
            };
            let (character_id, chat_id, content) = match draft {
                Ok(draft) => draft,
                Err(error) => {
                    toast_overlay.add_toast(adw::Toast::new(&error.to_string()));
                    return;
                }
            };
            let Some(repository) = &repository else {
                toast_overlay.add_toast(adw::Toast::new(
                    "SQLite가 연결되지 않아 메시지를 저장할 수 없습니다.",
                ));
                return;
            };
            match repository.borrow_mut().append_user_message(
                &character_id,
                chat_id.as_deref(),
                &content,
            ) {
                Ok(stored) => {
                    state.borrow_mut().append_message(
                        &character_id,
                        stored.chat_id,
                        stored.message,
                    );
                    buffer.set_text("");
                    pending_images.borrow_mut().clear();
                    if let Some(asset_store) = &asset_store {
                        render_pending_images(
                            &attachment_preview,
                            &attachment_scroller,
                            &pending_images,
                            asset_store,
                            &toast_overlay,
                        );
                    }
                    controller.start(None);
                }
                Err(error) => toast_overlay.add_toast(adw::Toast::new(&format!(
                    "메시지를 저장하지 못했습니다: {error}"
                ))),
            }
        });
    }

    content
}

fn build_character_rows(state: &AppState, character_list: &gtk::ListBox) -> CharacterRows {
    Rc::new(RefCell::new(
        state
            .characters
            .iter()
            .map(|character| {
                let row = build_character_row(character);
                let searchable =
                    format!("{} {}", character.name, character.description).to_lowercase();
                character_list.append(&row);
                (row, searchable)
            })
            .collect(),
    ))
}

fn show_new_character_dialog(
    toast_overlay: &adw::ToastOverlay,
    state: &Rc<RefCell<AppState>>,
    repository: Option<&Rc<RefCell<Repository>>>,
    character_list: &gtk::ListBox,
    character_rows: &CharacterRows,
) {
    let Some(window) = toast_overlay.root().and_downcast::<gtk::Window>() else {
        return;
    };
    let dialog = gtk::Dialog::builder()
        .title("새 캐릭터")
        .transient_for(&window)
        .modal(true)
        .default_width(380)
        .build();
    dialog.add_button("취소", gtk::ResponseType::Cancel);
    dialog.add_button("만들기", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Accept);

    let form = gtk::Box::new(Orientation::Vertical, 8);
    form.set_margin_top(18);
    form.set_margin_bottom(18);
    form.set_margin_start(18);
    form.set_margin_end(18);
    let label = gtk::Label::new(Some("캐릭터 이름"));
    label.set_xalign(0.0);
    label.add_css_class("heading");
    form.append(&label);
    let entry = gtk::Entry::builder()
        .placeholder_text("예: Mina")
        .activates_default(true)
        .build();
    form.append(&entry);
    let hint = gtk::Label::new(Some(
        "생성 후 캐릭터 설명과 첫 메시지는 편집 화면에서 설정할 수 있습니다.",
    ));
    hint.set_wrap(true);
    hint.set_xalign(0.0);
    hint.add_css_class("dim-label");
    hint.add_css_class("caption");
    form.append(&hint);
    dialog.content_area().append(&form);

    let toast_overlay = toast_overlay.clone();
    let state = Rc::clone(state);
    let repository = repository.cloned();
    let character_list = character_list.clone();
    let character_rows = Rc::clone(character_rows);
    dialog.connect_response(move |dialog, response| {
        if response != gtk::ResponseType::Accept {
            dialog.close();
            return;
        }
        let Some(repository) = &repository else {
            toast_overlay.add_toast(adw::Toast::new(
                "SQLite가 연결되지 않아 캐릭터를 만들 수 없습니다.",
            ));
            return;
        };
        match repository
            .borrow_mut()
            .create_character(entry.text().as_str())
        {
            Ok(character) => {
                let row = build_character_row(&character);
                let searchable =
                    format!("{} {}", character.name, character.description).to_lowercase();
                state.borrow_mut().characters.push(character);
                character_list.append(&row);
                character_rows.borrow_mut().push((row.clone(), searchable));
                character_list.select_row(Some(&row));
                dialog.close();
                toast_overlay.add_toast(adw::Toast::new("새 캐릭터를 만들었습니다."));
            }
            Err(error) => {
                toast_overlay.add_toast(adw::Toast::new(&error.to_string()));
                entry.grab_focus();
            }
        }
    });
    dialog.present();
}

fn initialize_saved_provider(provider: ProviderServices, settings: ProviderSettings) {
    let Some(credential_id) = settings.credential_id.clone() else {
        activate_provider(&provider, settings, None);
        return;
    };
    let Some(secret_store) = &provider.secret_store else {
        provider.toast_overlay.add_toast(adw::Toast::new(
            "저장된 API 키를 읽을 비밀 저장소가 없습니다.",
        ));
        return;
    };
    provider.subtitle.set_label("Loading secure credential…");
    let receiver = secret_store.load(credential_id);
    gtk::glib::MainContext::default().spawn_local(async move {
        match receiver
            .recv()
            .await
            .unwrap_or(Err(SecretError::Interrupted))
        {
            Ok(Some(api_key)) => activate_provider(&provider, settings, Some(api_key)),
            Ok(None) => {
                provider.subtitle.set_label("Secure credential missing");
                provider.toast_overlay.add_toast(adw::Toast::new(
                    "공급자 설정은 있지만 데스크톱 비밀 저장소에서 API 키를 찾지 못했습니다.",
                ));
            }
            Err(error) => {
                provider.subtitle.set_label("Secure credential unavailable");
                provider.toast_overlay.add_toast(adw::Toast::new(&format!(
                    "저장된 API 키를 읽지 못했습니다: {error}"
                )));
            }
        }
    });
}

fn activate_provider(
    provider: &ProviderServices,
    settings: ProviderSettings,
    api_key: Option<Zeroizing<String>>,
) {
    match ChatService::from_settings(&settings, api_key) {
        Ok(service) => {
            *provider.chat_service.borrow_mut() = Some(Rc::new(service));
            *provider.settings.borrow_mut() = Some(settings.clone());
            provider.model_button.set_label(&settings.model);
            provider.subtitle.set_label(&settings.model);
        }
        Err(error) => {
            *provider.chat_service.borrow_mut() = None;
            provider.subtitle.set_label("AI provider unavailable");
            provider.toast_overlay.add_toast(adw::Toast::new(&format!(
                "AI 공급자를 초기화하지 못했습니다: {error}"
            )));
        }
    }
}

fn provider_kind_from_selected(selected: u32) -> ProviderKind {
    match selected {
        1 => ProviderKind::Anthropic,
        2 => ProviderKind::Gemini,
        _ => ProviderKind::OpenAiCompatible,
    }
}

fn provider_kind_from_api_type(api_type: &str) -> ProviderKind {
    let api_type = api_type.to_ascii_lowercase();
    if api_type.contains("anthropic") || api_type.contains("claude") {
        ProviderKind::Anthropic
    } else if api_type.contains("gemini") || api_type.contains("google") {
        ProviderKind::Gemini
    } else {
        ProviderKind::OpenAiCompatible
    }
}

fn provider_default_base_url(provider_kind: ProviderKind) -> &'static str {
    match provider_kind {
        ProviderKind::OpenAiCompatible => DEFAULT_BASE_URL,
        ProviderKind::Anthropic => DEFAULT_ANTHROPIC_BASE_URL,
        ProviderKind::Gemini => DEFAULT_GEMINI_BASE_URL,
    }
}

fn show_provider_settings(provider: &ProviderServices) {
    let Some(window) = provider.toast_overlay.root().and_downcast::<gtk::Window>() else {
        return;
    };
    let current = provider.settings.borrow().clone();
    let current_model = current
        .as_ref()
        .map(|settings| settings.model.clone())
        .or_else(|| {
            provider
                .chat_service
                .borrow()
                .as_ref()
                .map(|service| service.model().to_owned())
        })
        .unwrap_or_default();
    let current_provider_kind = current
        .as_ref()
        .map(|settings| settings.provider_kind)
        .unwrap_or_default();
    let current_base_url = current
        .as_ref()
        .map(|settings| settings.base_url.clone())
        .unwrap_or_else(|| provider_default_base_url(current_provider_kind).into());
    let current_context_tokens = current
        .as_ref()
        .map(|settings| settings.max_context_tokens)
        .unwrap_or(DEFAULT_CONTEXT_TOKENS);
    let current_output_tokens = current
        .as_ref()
        .map(|settings| settings.max_output_tokens)
        .unwrap_or(DEFAULT_OUTPUT_TOKENS);
    let current_memory_mode = current
        .as_ref()
        .map(|settings| settings.memory_mode)
        .unwrap_or_default();
    let current_embedding_model = current
        .as_ref()
        .map(|settings| settings.embedding_model.clone())
        .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.into());
    let current_memory_allocated_tokens = current
        .as_ref()
        .map(|settings| settings.memory_allocated_tokens)
        .unwrap_or(DEFAULT_MEMORY_ALLOCATED_TOKENS);
    let current_memory_chunk_tokens = current
        .as_ref()
        .map(|settings| settings.memory_chunk_tokens)
        .unwrap_or(DEFAULT_MEMORY_CHUNK_TOKENS);
    let current_hypa_v3 = current
        .as_ref()
        .map(|settings| settings.hypa_v3.clone())
        .unwrap_or_default();
    let old_credential_id = current.and_then(|settings| settings.credential_id);

    let dialog = gtk::Dialog::builder()
        .title("AI 공급자 설정")
        .transient_for(&window)
        .modal(true)
        .default_width(560)
        .default_height(820)
        .build();
    dialog.add_button("취소", gtk::ResponseType::Cancel);
    dialog.add_button("저장", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Accept);

    let form = gtk::Box::new(Orientation::Vertical, 12);
    form.set_margin_top(18);
    form.set_margin_bottom(18);
    form.set_margin_start(18);
    form.set_margin_end(18);

    let provider_kind =
        gtk::DropDown::from_strings(&["OpenAI 호환", "Anthropic Messages", "Google Gemini"]);
    provider_kind.set_selected(match current_provider_kind {
        ProviderKind::OpenAiCompatible => 0,
        ProviderKind::Anthropic => 1,
        ProviderKind::Gemini => 2,
    });
    append_compact_control(&form, "공급자 형식", &provider_kind);

    let base_url_label = gtk::Label::new(Some("공급자 기본 URL"));
    base_url_label.set_xalign(0.0);
    base_url_label.add_css_class("heading");
    form.append(&base_url_label);
    let base_url = gtk::Entry::builder()
        .text(&current_base_url)
        .placeholder_text(provider_default_base_url(current_provider_kind))
        .build();
    form.append(&base_url);
    {
        let base_url = base_url.clone();
        provider_kind.connect_selected_notify(move |provider_kind| {
            let current = base_url.text();
            if [
                DEFAULT_BASE_URL,
                DEFAULT_ANTHROPIC_BASE_URL,
                DEFAULT_GEMINI_BASE_URL,
            ]
            .contains(&current.as_str())
            {
                let kind = provider_kind_from_selected(provider_kind.selected());
                let default = provider_default_base_url(kind);
                base_url.set_text(default);
                base_url.set_placeholder_text(Some(default));
            }
        });
    }

    let model_label = gtk::Label::new(Some("모델 ID"));
    model_label.set_xalign(0.0);
    model_label.add_css_class("heading");
    form.append(&model_label);
    let model = gtk::Entry::builder()
        .text(&current_model)
        .placeholder_text("예: gpt-4.1-mini")
        .build();
    form.append(&model);

    let token_limits = gtk::Box::new(Orientation::Horizontal, 12);
    let max_context_tokens = gtk::SpinButton::with_range(1.0, 10_000_000.0, 1_000.0);
    max_context_tokens.set_value(current_context_tokens as f64);
    max_context_tokens.set_hexpand(true);
    append_compact_control(&token_limits, "최대 컨텍스트", &max_context_tokens);
    let max_output_tokens = gtk::SpinButton::with_range(1.0, 10_000_000.0, 100.0);
    max_output_tokens.set_value(current_output_tokens as f64);
    max_output_tokens.set_hexpand(true);
    append_compact_control(&token_limits, "최대 응답", &max_output_tokens);
    form.append(&token_limits);

    let memory_options = gtk::Box::new(Orientation::Horizontal, 12);
    let memory_mode = gtk::DropDown::from_strings(&[
        "SupaMemory",
        "HypaMemory",
        "HypaMemory V2",
        "HypaMemory V3",
    ]);
    memory_mode.set_selected(match current_memory_mode {
        MemoryMode::Supa => 0,
        MemoryMode::Hypa => 1,
        MemoryMode::HypaV2 => 2,
        MemoryMode::HypaV3 => 3,
    });
    memory_mode.set_hexpand(true);
    append_compact_control(&memory_options, "메모리 방식", &memory_mode);
    let embedding_model = gtk::Entry::builder()
        .text(&current_embedding_model)
        .placeholder_text(DEFAULT_EMBEDDING_MODEL)
        .hexpand(true)
        .build();
    append_compact_control(&memory_options, "임베딩 모델", &embedding_model);
    form.append(&memory_options);
    let memory_tokens = gtk::Box::new(Orientation::Horizontal, 12);
    let memory_allocated_tokens = gtk::SpinButton::with_range(1.0, 10_000_000.0, 100.0);
    memory_allocated_tokens.set_value(current_memory_allocated_tokens as f64);
    memory_allocated_tokens.set_hexpand(true);
    append_compact_control(&memory_tokens, "V2 메모리 예산", &memory_allocated_tokens);
    let memory_chunk_tokens = gtk::SpinButton::with_range(1.0, 10_000_000.0, 100.0);
    memory_chunk_tokens.set_value(current_memory_chunk_tokens as f64);
    memory_chunk_tokens.set_hexpand(true);
    append_compact_control(&memory_tokens, "V2 요약 청크", &memory_chunk_tokens);
    form.append(&memory_tokens);
    let memory_note = gtk::Label::new(Some(
        "HypaMemory 계열의 유사도 검색은 현재 OpenAI 호환 공급자의 /embeddings를 사용합니다. Anthropic/Gemini 네이티브 형식에서는 SupaMemory를 선택하세요.",
    ));
    memory_note.set_wrap(true);
    memory_note.set_xalign(0.0);
    memory_note.add_css_class("dim-label");
    form.append(&memory_note);

    let v3_title = gtk::Label::new(Some("HypaMemory V3"));
    v3_title.set_xalign(0.0);
    v3_title.add_css_class("heading");
    form.append(&v3_title);
    let v3_ratios = gtk::Box::new(Orientation::Horizontal, 12);
    let v3_memory_ratio = gtk::SpinButton::with_range(0.01, 100.0, 1.0);
    v3_memory_ratio.set_digits(2);
    v3_memory_ratio.set_value(current_hypa_v3.memory_ratio_bps as f64 / 100.0);
    v3_memory_ratio.set_hexpand(true);
    append_compact_control(&v3_ratios, "메모리 비율 (%)", &v3_memory_ratio);
    let v3_extra_ratio = gtk::SpinButton::with_range(0.0, 99.0, 1.0);
    v3_extra_ratio.set_digits(2);
    v3_extra_ratio.set_value(current_hypa_v3.extra_summarization_ratio_bps as f64 / 100.0);
    v3_extra_ratio.set_hexpand(true);
    append_compact_control(&v3_ratios, "추가 요약 여유 (%)", &v3_extra_ratio);
    form.append(&v3_ratios);

    let v3_selection_ratios = gtk::Box::new(Orientation::Horizontal, 12);
    let v3_recent_ratio = gtk::SpinButton::with_range(0.0, 100.0, 1.0);
    v3_recent_ratio.set_digits(2);
    v3_recent_ratio.set_value(current_hypa_v3.recent_ratio_bps as f64 / 100.0);
    v3_recent_ratio.set_hexpand(true);
    append_compact_control(&v3_selection_ratios, "최근 요약 (%)", &v3_recent_ratio);
    let v3_similar_ratio = gtk::SpinButton::with_range(0.0, 100.0, 1.0);
    v3_similar_ratio.set_digits(2);
    v3_similar_ratio.set_value(current_hypa_v3.similar_ratio_bps as f64 / 100.0);
    v3_similar_ratio.set_hexpand(true);
    append_compact_control(&v3_selection_ratios, "유사 요약 (%)", &v3_similar_ratio);
    form.append(&v3_selection_ratios);

    let v3_counts = gtk::Box::new(Orientation::Horizontal, 12);
    let v3_max_messages = gtk::SpinButton::with_range(1.0, 10_000.0, 1.0);
    v3_max_messages.set_value(current_hypa_v3.max_messages_per_summary as f64);
    v3_max_messages.set_hexpand(true);
    append_compact_control(&v3_counts, "요약당 메시지", &v3_max_messages);
    let v3_query_messages = gtk::SpinButton::with_range(1.0, 10_000.0, 1.0);
    v3_query_messages.set_value(current_hypa_v3.query_message_count as f64);
    v3_query_messages.set_hexpand(true);
    append_compact_control(&v3_counts, "검색 질의 메시지", &v3_query_messages);
    form.append(&v3_counts);

    let v3_flags = gtk::Box::new(Orientation::Horizontal, 12);
    let v3_preserve_orphans = gtk::CheckButton::with_label("고아 요약 보존");
    v3_preserve_orphans.set_active(current_hypa_v3.preserve_orphaned_memory);
    let v3_skip_user = gtk::CheckButton::with_label("사용자 메시지 요약 제외");
    v3_skip_user.set_active(current_hypa_v3.do_not_summarize_user_messages);
    let v3_similarity_correction = gtk::CheckButton::with_label("검색 질의 요약 보정");
    v3_similarity_correction.set_active(current_hypa_v3.enable_similarity_correction);
    v3_flags.append(&v3_preserve_orphans);
    v3_flags.append(&v3_skip_user);
    v3_flags.append(&v3_similarity_correction);
    form.append(&v3_flags);

    let v3_separator = gtk::Entry::builder()
        .text(&current_hypa_v3.summary_chunk_separator)
        .placeholder_text("\\n\\n 또는 /정규식/g")
        .build();
    append_compact_control(&form, "요약 청크 구분자", &v3_separator);
    let v3_prompt_label = gtk::Label::new(Some("V3 요약 프롬프트 ({{slot}} 지원)"));
    v3_prompt_label.set_xalign(0.0);
    form.append(&v3_prompt_label);
    let v3_prompt = gtk::TextView::new();
    v3_prompt.set_wrap_mode(gtk::WrapMode::WordChar);
    v3_prompt.buffer().set_text(&current_hypa_v3.summary_prompt);
    v3_prompt.set_size_request(-1, 90);
    form.append(&v3_prompt);

    if !provider.presets.is_empty() {
        let preset_label = gtk::Label::new(Some("기존 RisuAI 프리셋에서 모델 가져오기"));
        preset_label.set_xalign(0.0);
        preset_label.add_css_class("heading");
        form.append(&preset_label);
        let presets = gtk::ComboBoxText::new();
        presets.append(None, "프리셋을 선택하세요");
        for preset in provider.presets.iter() {
            let name = if preset.name.trim().is_empty() {
                "이름 없는 프리셋"
            } else {
                &preset.name
            };
            presets.append(
                Some(&preset.id),
                &format!("{name} · {} · {}", preset.api_type, preset.model),
            );
        }
        presets.set_active(Some(0));
        form.append(&presets);
        let model = model.clone();
        let provider_kind = provider_kind.clone();
        let preset_summaries = Rc::clone(&provider.presets);
        presets.connect_changed(move |presets| {
            let Some(id) = presets.active_id() else {
                return;
            };
            if let Some(preset) = preset_summaries.iter().find(|preset| preset.id == id)
                && !preset.model.trim().is_empty()
            {
                model.set_text(&preset.model);
                provider_kind.set_selected(match provider_kind_from_api_type(&preset.api_type) {
                    ProviderKind::OpenAiCompatible => 0,
                    ProviderKind::Anthropic => 1,
                    ProviderKind::Gemini => 2,
                });
            }
        });
    }

    let key_label = gtk::Label::new(Some("API 키"));
    key_label.set_xalign(0.0);
    key_label.add_css_class("heading");
    form.append(&key_label);
    let api_key = gtk::PasswordEntry::builder()
        .show_peek_icon(true)
        .placeholder_text(if old_credential_id.is_some() {
            "비워두면 저장된 키 유지"
        } else {
            "로컬 서버라면 비워둘 수 있습니다"
        })
        .build();
    form.append(&api_key);
    let remove_key = gtk::CheckButton::with_label("저장된 API 키 제거");
    remove_key.set_sensitive(old_credential_id.is_some());
    {
        let api_key = api_key.clone();
        remove_key.connect_toggled(move |remove| {
            api_key.set_sensitive(!remove.is_active());
            if remove.is_active() {
                api_key.set_text("");
            }
        });
    }
    form.append(&remove_key);
    let security_note = gtk::Label::new(Some(
        "API 키는 SQLite나 프리셋 JSON에 저장하지 않고 데스크톱 Secret Service에만 보관합니다. 기존 프리셋의 평문 키는 읽지 않습니다.",
    ));
    security_note.set_wrap(true);
    security_note.set_xalign(0.0);
    security_note.add_css_class("dim-label");
    security_note.add_css_class("caption");
    form.append(&security_note);
    let form_scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .child(&form)
        .build();
    dialog.content_area().append(&form_scroller);

    let provider = provider.clone();
    dialog.connect_response(move |dialog, response| {
        if response != gtk::ResponseType::Accept {
            dialog.close();
            return;
        }
        let credential_id = if remove_key.is_active() {
            None
        } else {
            old_credential_id.clone()
        };
        let settings = match validate_settings(
            base_url.text().as_str(),
            provider_kind_from_selected(provider_kind.selected()),
            model.text().as_str(),
            max_context_tokens.value_as_int().max(0) as usize,
            max_output_tokens.value_as_int().max(0) as usize,
            match memory_mode.selected() {
                1 => MemoryMode::Hypa,
                2 => MemoryMode::HypaV2,
                3 => MemoryMode::HypaV3,
                _ => MemoryMode::Supa,
            },
            embedding_model.text().as_str(),
            memory_allocated_tokens.value_as_int().max(0) as usize,
            memory_chunk_tokens.value_as_int().max(0) as usize,
            HypaV3Settings {
                memory_ratio_bps: (v3_memory_ratio.value() * 100.0).round() as u16,
                extra_summarization_ratio_bps: (v3_extra_ratio.value() * 100.0).round() as u16,
                max_messages_per_summary: v3_max_messages.value_as_int().max(0) as usize,
                recent_ratio_bps: (v3_recent_ratio.value() * 100.0).round() as u16,
                similar_ratio_bps: (v3_similar_ratio.value() * 100.0).round() as u16,
                query_message_count: v3_query_messages.value_as_int().max(0) as usize,
                preserve_orphaned_memory: v3_preserve_orphans.is_active(),
                do_not_summarize_user_messages: v3_skip_user.is_active(),
                enable_similarity_correction: v3_similarity_correction.is_active(),
                summary_chunk_separator: v3_separator.text().to_string(),
                summary_prompt: text_view_text(&v3_prompt),
            },
            credential_id,
        ) {
            Ok(settings) => settings,
            Err(error) => {
                provider
                    .toast_overlay
                    .add_toast(adw::Toast::new(&error.to_string()));
                return;
            }
        };
        let entered_key = Zeroizing::new(api_key.text().to_string());
        api_key.set_text("");
        set_provider_dialog_busy(dialog, true);

        if !entered_key.trim().is_empty() {
            begin_provider_save_with_new_secret(
                provider.clone(),
                dialog.clone(),
                settings,
                entered_key,
                old_credential_id.clone(),
            );
        } else if remove_key.is_active() || old_credential_id.is_none() {
            persist_and_activate_provider(
                &provider,
                dialog,
                settings,
                None,
                None,
                old_credential_id.clone(),
            );
        } else {
            begin_provider_save_with_existing_secret(provider.clone(), dialog.clone(), settings);
        }
    });
    dialog.present();
}

fn begin_provider_save_with_new_secret(
    provider: ProviderServices,
    dialog: gtk::Dialog,
    mut settings: ProviderSettings,
    api_key: Zeroizing<String>,
    old_credential_id: Option<String>,
) {
    let Some(secret_store) = &provider.secret_store else {
        set_provider_dialog_busy(&dialog, false);
        provider.toast_overlay.add_toast(adw::Toast::new(
            "데스크톱 비밀 저장소를 사용할 수 없어 API 키를 저장하지 않았습니다.",
        ));
        return;
    };
    let credential_id = uuid::Uuid::new_v4().to_string();
    settings.credential_id = Some(credential_id.clone());
    let receiver = secret_store.store(credential_id.clone(), api_key.clone());
    gtk::glib::MainContext::default().spawn_local(async move {
        match receiver
            .recv()
            .await
            .unwrap_or(Err(SecretError::Interrupted))
        {
            Ok(()) => persist_and_activate_provider(
                &provider,
                &dialog,
                settings,
                Some(api_key),
                Some(credential_id),
                old_credential_id,
            ),
            Err(error) => {
                set_provider_dialog_busy(&dialog, false);
                provider.toast_overlay.add_toast(adw::Toast::new(&format!(
                    "API 키를 안전하게 저장하지 못했습니다: {error}"
                )));
            }
        }
    });
}

fn begin_provider_save_with_existing_secret(
    provider: ProviderServices,
    dialog: gtk::Dialog,
    settings: ProviderSettings,
) {
    let Some(credential_id) = settings.credential_id.clone() else {
        persist_and_activate_provider(&provider, &dialog, settings, None, None, None);
        return;
    };
    let Some(secret_store) = &provider.secret_store else {
        set_provider_dialog_busy(&dialog, false);
        provider.toast_overlay.add_toast(adw::Toast::new(
            "저장된 API 키를 읽을 데스크톱 비밀 저장소가 없습니다.",
        ));
        return;
    };
    let receiver = secret_store.load(credential_id);
    gtk::glib::MainContext::default().spawn_local(async move {
        match receiver
            .recv()
            .await
            .unwrap_or(Err(SecretError::Interrupted))
        {
            Ok(Some(api_key)) => persist_and_activate_provider(
                &provider,
                &dialog,
                settings,
                Some(api_key),
                None,
                None,
            ),
            Ok(None) => {
                set_provider_dialog_busy(&dialog, false);
                provider.toast_overlay.add_toast(adw::Toast::new(
                    "저장된 API 키를 찾지 못했습니다. 새 키를 입력하거나 제거를 선택해 주세요.",
                ));
            }
            Err(error) => {
                set_provider_dialog_busy(&dialog, false);
                provider.toast_overlay.add_toast(adw::Toast::new(&format!(
                    "저장된 API 키를 읽지 못했습니다: {error}"
                )));
            }
        }
    });
}

fn persist_and_activate_provider(
    provider: &ProviderServices,
    dialog: &gtk::Dialog,
    settings: ProviderSettings,
    api_key: Option<Zeroizing<String>>,
    new_credential_id: Option<String>,
    obsolete_credential_id: Option<String>,
) {
    let service = match ChatService::from_settings(&settings, api_key) {
        Ok(service) => service,
        Err(error) => {
            set_provider_dialog_busy(dialog, false);
            provider.toast_overlay.add_toast(adw::Toast::new(&format!(
                "AI 공급자를 초기화하지 못했습니다: {error}"
            )));
            cleanup_new_credential(provider, new_credential_id);
            return;
        }
    };
    let Some(repository) = &provider.repository else {
        set_provider_dialog_busy(dialog, false);
        provider.toast_overlay.add_toast(adw::Toast::new(
            "SQLite가 연결되지 않아 공급자 설정을 저장할 수 없습니다.",
        ));
        cleanup_new_credential(provider, new_credential_id);
        return;
    };
    if let Err(error) = repository.borrow_mut().save_provider_settings(&settings) {
        set_provider_dialog_busy(dialog, false);
        provider.toast_overlay.add_toast(adw::Toast::new(&format!(
            "공급자 설정을 저장하지 못했습니다: {error}"
        )));
        cleanup_new_credential(provider, new_credential_id);
        return;
    }

    *provider.chat_service.borrow_mut() = Some(Rc::new(service));
    *provider.settings.borrow_mut() = Some(settings.clone());
    provider.model_button.set_label(&settings.model);
    provider.subtitle.set_label(&settings.model);
    dialog.close();
    provider
        .toast_overlay
        .add_toast(adw::Toast::new("AI 공급자 설정을 저장하고 적용했습니다."));
    if obsolete_credential_id != settings.credential_id {
        cleanup_obsolete_credential(provider, obsolete_credential_id);
    }
}

fn cleanup_new_credential(provider: &ProviderServices, credential_id: Option<String>) {
    let (Some(secret_store), Some(credential_id)) = (&provider.secret_store, credential_id) else {
        return;
    };
    let receiver = secret_store.delete(credential_id);
    gtk::glib::MainContext::default().spawn_local(async move {
        let _ = receiver.recv().await;
    });
}

fn cleanup_obsolete_credential(provider: &ProviderServices, credential_id: Option<String>) {
    let (Some(secret_store), Some(credential_id)) = (&provider.secret_store, credential_id) else {
        return;
    };
    let receiver = secret_store.delete(credential_id);
    let toast_overlay = provider.toast_overlay.clone();
    gtk::glib::MainContext::default().spawn_local(async move {
        match receiver
            .recv()
            .await
            .unwrap_or(Err(SecretError::Interrupted))
        {
            Ok(()) => {}
            Err(error) => toast_overlay.add_toast(adw::Toast::new(&format!(
                "이전 API 키 참조를 정리하지 못했습니다: {error}"
            ))),
        }
    });
}

fn set_provider_dialog_busy(dialog: &gtk::Dialog, busy: bool) {
    dialog.set_deletable(!busy);
    for response in [gtk::ResponseType::Cancel, gtk::ResponseType::Accept] {
        if let Some(widget) = dialog.widget_for_response(response) {
            widget.set_sensitive(!busy);
        }
    }
}

fn show_memory_editor(
    toast_overlay: &adw::ToastOverlay,
    state: &Rc<RefCell<AppState>>,
    repository: Option<&Rc<RefCell<Repository>>>,
    memory_mode: MemoryMode,
) {
    let Some(window) = toast_overlay.root().and_downcast::<gtk::Window>() else {
        return;
    };
    let Some((character_id, chat_id, memory_data, hypa_v2_data, hypa_v3_data, messages)) =
        state.borrow().selected_character().and_then(|character| {
            Some((
                character.id.clone(),
                character.chat_id.clone()?,
                character.supa_memory_data.clone(),
                character.hypa_v2_data.clone(),
                character.hypa_v3_data.clone(),
                character.messages.clone(),
            ))
        })
    else {
        toast_overlay.add_toast(adw::Toast::new("메모리를 편집할 현재 채팅이 없습니다."));
        return;
    };

    let dialog = gtk::Dialog::builder()
        .title("메모리 상태 편집")
        .transient_for(&window)
        .modal(true)
        .default_width(680)
        .default_height(480)
        .build();
    dialog.add_button("취소", gtk::ResponseType::Cancel);
    dialog.add_button("저장", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Accept);

    let content = gtk::Box::new(Orientation::Vertical, 10);
    content.set_margin_top(16);
    content.set_margin_bottom(16);
    content.set_margin_start(16);
    content.set_margin_end(16);
    let note = gtk::Label::new(Some(match memory_mode {
        MemoryMode::HypaV2 => {
            "HypaMemory V2는 lastMainChunkID, mainChunks, chunks를 가진 JSON 객체입니다. 구형 targetId 형식도 저장 시 변환됩니다. 비우면 현재 채팅의 V2 상태를 초기화합니다."
        }
        MemoryMode::HypaV3 => {
            "HypaMemory V3는 summaries와 선택 metrics, 분류·태그를 가진 JSON 객체입니다. chatMemos는 이 채팅의 메시지 ID를 참조합니다. 비우면 현재 채팅의 V3 상태를 초기화합니다."
        }
        _ => {
            "SupaMemory는 첫 줄에 체크포인트 ID, 다음 줄부터 요약을 저장합니다. 구형 HypaMemory는 hypa: 다음 줄에 JSON 배열을 저장합니다. 비우면 현재 채팅의 상태를 초기화합니다."
        }
    }));
    note.set_wrap(true);
    note.set_xalign(0.0);
    note.add_css_class("dim-label");
    content.append(&note);
    let editor = gtk::TextView::new();
    editor.set_wrap_mode(gtk::WrapMode::WordChar);
    let initial_text = match memory_mode {
        MemoryMode::HypaV2 => hypa_v2_data
            .as_ref()
            .and_then(|state| serde_json::to_string_pretty(state).ok())
            .unwrap_or_default(),
        MemoryMode::HypaV3 => hypa_v3_data
            .as_ref()
            .and_then(|state| serde_json::to_string_pretty(state).ok())
            .unwrap_or_default(),
        _ => memory_data.unwrap_or_default(),
    };
    editor.buffer().set_text(&initial_text);
    editor.set_top_margin(8);
    editor.set_bottom_margin(8);
    editor.set_left_margin(8);
    editor.set_right_margin(8);
    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .child(&editor)
        .build();
    scroller.add_css_class("profile-editor");
    content.append(&scroller);
    dialog.content_area().append(&content);

    let toast_overlay = toast_overlay.clone();
    let state = Rc::clone(state);
    let repository = repository.cloned();
    dialog.connect_response(move |dialog, response| {
        if response != gtk::ResponseType::Accept {
            dialog.close();
            return;
        }
        let Some(repository) = &repository else {
            toast_overlay.add_toast(adw::Toast::new(
                "SQLite가 연결되지 않아 메모리 상태를 저장할 수 없습니다.",
            ));
            return;
        };
        let data = text_view_text(&editor);
        let data = (!data.trim().is_empty()).then_some(data);
        if memory_mode == MemoryMode::HypaV2 {
            let hypa_state = match data.as_deref() {
                Some(data) => {
                    let value = match serde_json::from_str(data) {
                        Ok(value) => value,
                        Err(error) => {
                            toast_overlay.add_toast(adw::Toast::new(&format!(
                                "HypaMemory V2 JSON을 해석하지 못했습니다: {error}"
                            )));
                            return;
                        }
                    };
                    match HypaV2State::from_json_value(value, &messages) {
                        Ok(state) => Some(state),
                        Err(error) => {
                            toast_overlay.add_toast(adw::Toast::new(&error.to_string()));
                            return;
                        }
                    }
                }
                None => None,
            };
            match repository.borrow_mut().save_hypa_v2_memory(
                &character_id,
                &chat_id,
                hypa_state.as_ref(),
            ) {
                Ok(()) => {
                    if !state.borrow_mut().update_hypa_v2_memory(
                        &character_id,
                        &chat_id,
                        hypa_state,
                    ) {
                        toast_overlay.add_toast(adw::Toast::new(
                            "V2 메모리는 저장됐지만 선택된 채팅이 바뀌어 화면 상태를 갱신하지 못했습니다.",
                        ));
                    } else {
                        toast_overlay
                            .add_toast(adw::Toast::new("HypaMemory V2 상태를 저장했습니다."));
                    }
                    dialog.close();
                }
                Err(error) => toast_overlay.add_toast(adw::Toast::new(&error.to_string())),
            }
            return;
        }
        if memory_mode == MemoryMode::HypaV3 {
            let hypa_state = match data.as_deref() {
                Some(data) => {
                    let value = match serde_json::from_str(data) {
                        Ok(value) => value,
                        Err(error) => {
                            toast_overlay.add_toast(adw::Toast::new(&format!(
                                "HypaMemory V3 JSON을 해석하지 못했습니다: {error}"
                            )));
                            return;
                        }
                    };
                    match HypaV3State::from_json_value(value, &messages, true) {
                        Ok(state) => Some(state),
                        Err(error) => {
                            toast_overlay.add_toast(adw::Toast::new(&error.to_string()));
                            return;
                        }
                    }
                }
                None => None,
            };
            match repository.borrow_mut().save_hypa_v3_memory(
                &character_id,
                &chat_id,
                hypa_state.as_ref(),
            ) {
                Ok(()) => {
                    if !state.borrow_mut().update_hypa_v3_memory(
                        &character_id,
                        &chat_id,
                        hypa_state,
                    ) {
                        toast_overlay.add_toast(adw::Toast::new(
                            "V3 메모리는 저장됐지만 선택된 채팅이 바뀌어 화면 상태를 갱신하지 못했습니다.",
                        ));
                    } else {
                        toast_overlay
                            .add_toast(adw::Toast::new("HypaMemory V3 상태를 저장했습니다."));
                    }
                    dialog.close();
                }
                Err(error) => toast_overlay.add_toast(adw::Toast::new(&error.to_string())),
            }
            return;
        }
        if let Err(error) = validate_memory_state(data.as_deref()) {
            toast_overlay.add_toast(adw::Toast::new(&error.to_string()));
            return;
        }
        match repository
            .borrow_mut()
            .save_supa_memory(&character_id, &chat_id, data.as_deref())
        {
            Ok(()) => {
                if !state
                    .borrow_mut()
                    .update_supa_memory(&character_id, &chat_id, data)
                {
                    toast_overlay.add_toast(adw::Toast::new(
                        "메모리는 저장됐지만 선택된 채팅이 바뀌어 화면 상태를 갱신하지 못했습니다.",
                    ));
                } else {
                    toast_overlay.add_toast(adw::Toast::new("메모리 상태를 저장했습니다."));
                }
                dialog.close();
            }
            Err(error) => toast_overlay.add_toast(adw::Toast::new(&error.to_string())),
        }
    });
    dialog.present();
}

const LORE_MODES: [&str; 5] = ["normal", "constant", "multiple", "folder", "child"];

type LoreEditors = Rc<RefCell<Vec<LoreEntryEditor>>>;

#[derive(Clone)]
struct LoreEntryEditor {
    editor_id: String,
    source_index: Option<usize>,
    lore_id: Option<String>,
    name: gtk::Entry,
    key: gtk::Entry,
    second_key: gtk::Entry,
    content: gtk::TextView,
    insertion_order: gtk::SpinButton,
    activation_percent: gtk::SpinButton,
    mode: gtk::DropDown,
    always_active: gtk::CheckButton,
    selective: gtk::CheckButton,
    use_regex: gtk::CheckButton,
    case_sensitive: gtk::CheckButton,
}

impl LoreEntryEditor {
    fn lore(&self) -> LoreEntry {
        let activation_percent = self.activation_percent.value_as_int();
        LoreEntry {
            source_index: self.source_index,
            id: self.lore_id.clone(),
            key: self.key.text().to_string(),
            second_key: self.second_key.text().to_string(),
            insertion_order: i64::from(self.insertion_order.value_as_int()),
            name: self.name.text().to_string(),
            content: text_view_text(&self.content),
            mode: LORE_MODES
                .get(self.mode.selected() as usize)
                .copied()
                .unwrap_or("normal")
                .to_owned(),
            always_active: self.always_active.is_active(),
            selective: self.selective.is_active(),
            use_regex: self.use_regex.is_active(),
            case_sensitive: self.case_sensitive.is_active(),
            activation_percent: (activation_percent >= 0).then_some(activation_percent as u8),
        }
    }
}

fn show_lorebook_editor(
    toast_overlay: &adw::ToastOverlay,
    state: &Rc<RefCell<AppState>>,
    repository: Option<&Rc<RefCell<Repository>>>,
) {
    let Some(window) = toast_overlay.root().and_downcast::<gtk::Window>() else {
        return;
    };
    let Some(character) = state.borrow().selected_character().cloned() else {
        toast_overlay.add_toast(adw::Toast::new("로어북을 편집할 캐릭터를 선택해 주세요."));
        return;
    };
    let Some(chat_id) = character.chat_id.clone() else {
        toast_overlay.add_toast(adw::Toast::new("현재 채팅을 찾을 수 없습니다."));
        return;
    };

    let dialog = gtk::Dialog::builder()
        .title("로어북 편집")
        .transient_for(&window)
        .modal(true)
        .default_width(860)
        .default_height(760)
        .build();
    dialog.add_button("취소", gtk::ResponseType::Cancel);
    dialog.add_button("저장", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Accept);

    let root = gtk::Box::new(Orientation::Vertical, 12);
    root.set_margin_top(14);
    root.set_margin_bottom(14);
    root.set_margin_start(14);
    root.set_margin_end(14);

    let settings_box = gtk::Box::new(Orientation::Horizontal, 12);
    settings_box.add_css_class("toolbar");
    let token_budget = gtk::SpinButton::with_range(0.0, 1_000_000.0, 100.0);
    token_budget.set_value(character.lore_settings.token_budget as f64);
    append_compact_control(&settings_box, "토큰 예산", &token_budget);
    let scan_depth = gtk::SpinButton::with_range(0.0, 10_000.0, 1.0);
    scan_depth.set_value(character.lore_settings.scan_depth as f64);
    append_compact_control(&settings_box, "검색 깊이", &scan_depth);
    let recursive_scanning = gtk::CheckButton::with_label("재귀 검색");
    recursive_scanning.set_active(character.lore_settings.recursive_scanning);
    settings_box.append(&recursive_scanning);
    let full_word_matching = gtk::CheckButton::with_label("완전한 단어 일치");
    full_word_matching.set_active(character.lore_settings.full_word_matching);
    settings_box.append(&full_word_matching);
    root.append(&settings_box);

    let notebook = gtk::Notebook::new();
    notebook.set_vexpand(true);
    let (global_page, global_editors) = build_lore_page(&character.global_lore);
    notebook.append_page(&global_page, Some(&gtk::Label::new(Some("캐릭터 로어"))));
    let (local_page, local_editors) = build_lore_page(&character.local_lore);
    notebook.append_page(&local_page, Some(&gtk::Label::new(Some("현재 채팅 로어"))));
    root.append(&notebook);
    dialog.content_area().append(&root);

    let toast_overlay = toast_overlay.clone();
    let state = Rc::clone(state);
    let repository = repository.cloned();
    let character_id = character.id;
    dialog.connect_response(move |dialog, response| {
        if response != gtk::ResponseType::Accept {
            dialog.close();
            return;
        }
        let Some(repository) = &repository else {
            toast_overlay.add_toast(adw::Toast::new(
                "SQLite가 연결되지 않아 로어북을 저장할 수 없습니다.",
            ));
            return;
        };
        let global_lore = global_editors
            .borrow()
            .iter()
            .map(LoreEntryEditor::lore)
            .collect::<Vec<_>>();
        let local_lore = local_editors
            .borrow()
            .iter()
            .map(LoreEntryEditor::lore)
            .collect::<Vec<_>>();
        let lore_settings = LoreSettings {
            token_budget: token_budget.value_as_int().max(0) as usize,
            scan_depth: scan_depth.value_as_int().max(0) as usize,
            recursive_scanning: recursive_scanning.is_active(),
            full_word_matching: full_word_matching.is_active(),
        };
        match repository.borrow_mut().update_lorebooks(
            &character_id,
            &chat_id,
            &global_lore,
            &local_lore,
            &lore_settings,
        ) {
            Ok(()) => {
                let global_lore = normalize_lore_sources(global_lore);
                let local_lore = normalize_lore_sources(local_lore);
                if !state.borrow_mut().update_lorebooks(
                    &character_id,
                    &chat_id,
                    global_lore,
                    local_lore,
                    lore_settings,
                ) {
                    toast_overlay.add_toast(adw::Toast::new(
                        "로어북은 저장됐지만 선택 상태가 바뀌어 화면 상태를 갱신하지 못했습니다.",
                    ));
                    dialog.close();
                    return;
                }
                dialog.close();
                toast_overlay.add_toast(adw::Toast::new("로어북을 저장했습니다."));
            }
            Err(error) => toast_overlay.add_toast(adw::Toast::new(&error.to_string())),
        }
    });
    dialog.present();
}

fn normalize_lore_sources(mut lore: Vec<LoreEntry>) -> Vec<LoreEntry> {
    for (index, entry) in lore.iter_mut().enumerate() {
        entry.source_index = Some(index);
    }
    lore
}

fn append_compact_control<W: IsA<gtk::Widget>>(container: &gtk::Box, label: &str, widget: &W) {
    let group = gtk::Box::new(Orientation::Horizontal, 6);
    group.append(&gtk::Label::new(Some(label)));
    group.append(widget);
    container.append(&group);
}

fn build_lore_page(entries: &[LoreEntry]) -> (gtk::Box, LoreEditors) {
    let page = gtk::Box::new(Orientation::Vertical, 8);
    let toolbar = gtk::Box::new(Orientation::Horizontal, 8);
    toolbar.set_margin_top(8);
    toolbar.set_margin_start(8);
    toolbar.set_margin_end(8);
    let explanation = gtk::Label::new(Some("키와 활성화 조건에 따라 모델 프롬프트에 삽입됩니다."));
    explanation.add_css_class("dim-label");
    explanation.set_xalign(0.0);
    explanation.set_hexpand(true);
    toolbar.append(&explanation);
    let add = gtk::Button::builder()
        .label("로어 추가")
        .icon_name("list-add-symbolic")
        .build();
    toolbar.append(&add);
    page.append(&toolbar);

    let list = gtk::ListBox::new();
    list.set_selection_mode(gtk::SelectionMode::None);
    list.add_css_class("boxed-list");
    let editors = Rc::new(RefCell::new(Vec::new()));
    for entry in entries {
        append_lore_editor(&list, &editors, entry.clone());
    }
    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .child(&list)
        .build();
    page.append(&scroller);

    let list_for_add = list.clone();
    let editors_for_add = Rc::clone(&editors);
    add.connect_clicked(move |_| {
        append_lore_editor(
            &list_for_add,
            &editors_for_add,
            LoreEntry {
                source_index: None,
                id: Some(uuid::Uuid::new_v4().to_string()),
                key: String::new(),
                second_key: String::new(),
                insertion_order: 100,
                name: "새 로어".into(),
                content: String::new(),
                mode: "normal".into(),
                always_active: false,
                selective: false,
                use_regex: false,
                case_sensitive: false,
                activation_percent: None,
            },
        );
    });
    (page, editors)
}

fn append_lore_editor(list: &gtk::ListBox, editors: &LoreEditors, lore: LoreEntry) {
    let editor_id = uuid::Uuid::new_v4().to_string();
    let row = gtk::ListBoxRow::new();
    row.set_activatable(false);
    let expander = gtk::Expander::builder()
        .label(if lore.name.trim().is_empty() {
            "이름 없는 로어"
        } else {
            &lore.name
        })
        .build();
    let form = gtk::Box::new(Orientation::Vertical, 8);
    form.set_margin_top(8);
    form.set_margin_bottom(12);
    form.set_margin_start(12);
    form.set_margin_end(12);

    let name = append_lore_entry_field(&form, "이름", &lore.name);
    let expander_for_name = expander.clone();
    name.connect_changed(move |name| {
        let name = name.text();
        if name.trim().is_empty() {
            expander_for_name.set_label(Some("이름 없는 로어"));
        } else {
            expander_for_name.set_label(Some(name.as_str()));
        }
    });
    let key = append_lore_entry_field(&form, "주 키 (쉼표로 구분)", &lore.key);
    let second_key = append_lore_entry_field(&form, "보조 키", &lore.second_key);
    let content = append_lore_text_field(&form, "내용", &lore.content);

    let options = gtk::Box::new(Orientation::Horizontal, 10);
    let insertion_order = gtk::SpinButton::with_range(-100_000.0, 100_000.0, 1.0);
    insertion_order.set_value(lore.insertion_order as f64);
    append_compact_control(&options, "삽입 순서", &insertion_order);
    let activation_percent = gtk::SpinButton::with_range(-1.0, 100.0, 1.0);
    activation_percent.set_tooltip_text(Some("-1은 별도 확률 제한 없음"));
    activation_percent.set_value(lore.activation_percent.map_or(-1.0, f64::from));
    append_compact_control(&options, "활성 확률", &activation_percent);
    let mode = gtk::DropDown::from_strings(&LORE_MODES);
    let mode_index = LORE_MODES
        .iter()
        .position(|mode| *mode == lore.mode)
        .unwrap_or(0);
    mode.set_selected(mode_index as u32);
    append_compact_control(&options, "모드", &mode);
    form.append(&options);

    let toggles = gtk::Box::new(Orientation::Horizontal, 10);
    let always_active = gtk::CheckButton::with_label("항상 활성");
    always_active.set_active(lore.always_active);
    toggles.append(&always_active);
    let selective = gtk::CheckButton::with_label("보조 키 필수");
    selective.set_active(lore.selective);
    toggles.append(&selective);
    let use_regex = gtk::CheckButton::with_label("정규식 키");
    use_regex.set_active(lore.use_regex);
    toggles.append(&use_regex);
    let case_sensitive = gtk::CheckButton::with_label("대소문자 구분");
    case_sensitive.set_active(lore.case_sensitive);
    toggles.append(&case_sensitive);
    toggles.set_hexpand(true);
    let remove = gtk::Button::builder()
        .label("삭제")
        .icon_name("user-trash-symbolic")
        .css_classes(["destructive-action"])
        .build();
    toggles.append(&remove);
    form.append(&toggles);

    expander.set_child(Some(&form));
    row.set_child(Some(&expander));
    list.append(&row);
    editors.borrow_mut().push(LoreEntryEditor {
        editor_id: editor_id.clone(),
        source_index: lore.source_index,
        lore_id: Some(lore.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string())),
        name,
        key,
        second_key,
        content,
        insertion_order,
        activation_percent,
        mode,
        always_active,
        selective,
        use_regex,
        case_sensitive,
    });

    let list = list.clone();
    let weak_row = row.downgrade();
    let editors = Rc::clone(editors);
    remove.connect_clicked(move |_| {
        if let Some(row) = weak_row.upgrade() {
            list.remove(&row);
        }
        editors
            .borrow_mut()
            .retain(|editor| editor.editor_id != editor_id);
    });
}

fn append_lore_entry_field(form: &gtk::Box, label: &str, value: &str) -> gtk::Entry {
    let row = gtk::Box::new(Orientation::Horizontal, 8);
    let label = gtk::Label::new(Some(label));
    label.set_xalign(0.0);
    label.set_width_chars(18);
    row.append(&label);
    let entry = gtk::Entry::builder().text(value).hexpand(true).build();
    row.append(&entry);
    form.append(&row);
    entry
}

fn append_lore_text_field(form: &gtk::Box, label: &str, value: &str) -> gtk::TextView {
    let label = gtk::Label::new(Some(label));
    label.set_xalign(0.0);
    form.append(&label);
    let editor = gtk::TextView::new();
    editor.set_wrap_mode(gtk::WrapMode::WordChar);
    editor.buffer().set_text(value);
    editor.set_top_margin(8);
    editor.set_bottom_margin(8);
    editor.set_left_margin(8);
    editor.set_right_margin(8);
    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .min_content_height(120)
        .child(&editor)
        .build();
    scroller.add_css_class("profile-editor");
    form.append(&scroller);
    editor
}

#[derive(Clone)]
struct ProfileEditors {
    first_message: gtk::TextView,
    description: gtk::TextView,
    personality: gtk::TextView,
    scenario: gtk::TextView,
    system_prompt: gtk::TextView,
    post_history_instructions: gtk::TextView,
    example_message: gtk::TextView,
    creator_notes: gtk::TextView,
}

impl ProfileEditors {
    fn profile(&self) -> CharacterProfile {
        CharacterProfile {
            first_message: text_view_text(&self.first_message),
            description: text_view_text(&self.description),
            personality: text_view_text(&self.personality),
            scenario: text_view_text(&self.scenario),
            system_prompt: text_view_text(&self.system_prompt),
            post_history_instructions: text_view_text(&self.post_history_instructions),
            example_message: text_view_text(&self.example_message),
            creator_notes: text_view_text(&self.creator_notes),
        }
    }
}

fn show_character_editor(
    toast_overlay: &adw::ToastOverlay,
    state: &Rc<RefCell<AppState>>,
    repository: Option<&Rc<RefCell<Repository>>>,
    character_list: &gtk::ListBox,
    character_rows: &CharacterRows,
    title: &gtk::Label,
    message_list: &gtk::ListBox,
) {
    let Some(window) = toast_overlay.root().and_downcast::<gtk::Window>() else {
        return;
    };
    let Some(character) = state.borrow().selected_character().cloned() else {
        toast_overlay.add_toast(adw::Toast::new("편집할 캐릭터를 선택해 주세요."));
        return;
    };
    let dialog = gtk::Dialog::builder()
        .title("캐릭터 프로필 편집")
        .transient_for(&window)
        .modal(true)
        .default_width(700)
        .default_height(720)
        .build();
    dialog.add_button("취소", gtk::ResponseType::Cancel);
    dialog.add_button("저장", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Accept);

    let form = gtk::Box::new(Orientation::Vertical, 14);
    form.set_margin_top(18);
    form.set_margin_bottom(18);
    form.set_margin_start(18);
    form.set_margin_end(18);
    let name_label = gtk::Label::new(Some("이름"));
    name_label.set_xalign(0.0);
    name_label.add_css_class("heading");
    form.append(&name_label);
    let name = gtk::Entry::builder().text(&character.name).build();
    form.append(&name);
    let supa_memory_enabled = gtk::CheckButton::with_label(
        "메모리 사용 (공급자 설정에서 SupaMemory 또는 HypaMemory 선택)",
    );
    supa_memory_enabled.set_active(character.supa_memory_enabled);
    form.append(&supa_memory_enabled);

    let profile = &character.profile;
    let first_message = append_profile_field(&form, "첫 메시지", &profile.first_message, 90);
    let description = append_profile_field(&form, "설명", &profile.description, 120);
    let personality = append_profile_field(&form, "성격", &profile.personality, 100);
    let scenario = append_profile_field(&form, "시나리오", &profile.scenario, 100);
    let system_prompt = append_profile_field(&form, "시스템 프롬프트", &profile.system_prompt, 120);
    let post_history_instructions = append_profile_field(
        &form,
        "대화 이후 지시문",
        &profile.post_history_instructions,
        100,
    );
    let example_message = append_profile_field(&form, "예시 대화", &profile.example_message, 100);
    let creator_notes = append_profile_field(&form, "제작자 메모", &profile.creator_notes, 80);
    let editors = ProfileEditors {
        first_message,
        description,
        personality,
        scenario,
        system_prompt,
        post_history_instructions,
        example_message,
        creator_notes,
    };
    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .child(&form)
        .build();
    dialog.content_area().append(&scroller);

    let toast_overlay = toast_overlay.clone();
    let state = Rc::clone(state);
    let repository = repository.cloned();
    let character_list = character_list.clone();
    let character_rows = Rc::clone(character_rows);
    let title = title.clone();
    let message_list = message_list.clone();
    let character_id = character.id;
    dialog.connect_response(move |dialog, response| {
        if response != gtk::ResponseType::Accept {
            dialog.close();
            return;
        }
        let Some(repository) = &repository else {
            toast_overlay.add_toast(adw::Toast::new(
                "SQLite가 연결되지 않아 프로필을 저장할 수 없습니다.",
            ));
            return;
        };
        let profile = editors.profile();
        match repository.borrow_mut().update_character(
            &character_id,
            name.text().as_str(),
            &profile,
            supa_memory_enabled.is_active(),
        ) {
            Ok(saved_name) => {
                state.borrow_mut().update_character(
                    &character_id,
                    saved_name,
                    profile,
                    supa_memory_enabled.is_active(),
                );
                let selected_index = state.borrow().selected_index();
                if let Some(index) = selected_index {
                    let state = state.borrow();
                    if let Some(updated) = state.characters.get(index) {
                        if let Some(row) = character_list.row_at_index(index as i32) {
                            row.set_child(Some(&build_character_row_content(updated)));
                        }
                        if let Some((_, searchable)) = character_rows.borrow_mut().get_mut(index) {
                            *searchable =
                                format!("{} {}", updated.name, updated.description).to_lowercase();
                        }
                        title.set_label(&updated.name);
                        render_messages(&message_list, &updated.messages);
                    }
                }
                dialog.close();
                toast_overlay.add_toast(adw::Toast::new("캐릭터 프로필을 저장했습니다."));
            }
            Err(error) => {
                toast_overlay.add_toast(adw::Toast::new(&error.to_string()));
                name.grab_focus();
            }
        }
    });
    dialog.present();
}

fn append_profile_field(
    form: &gtk::Box,
    label: &str,
    value: &str,
    min_height: i32,
) -> gtk::TextView {
    let label = gtk::Label::new(Some(label));
    label.set_xalign(0.0);
    label.add_css_class("heading");
    form.append(&label);
    let editor = gtk::TextView::new();
    editor.set_wrap_mode(gtk::WrapMode::WordChar);
    editor.buffer().set_text(value);
    editor.set_top_margin(8);
    editor.set_bottom_margin(8);
    editor.set_left_margin(8);
    editor.set_right_margin(8);
    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .min_content_height(min_height)
        .child(&editor)
        .build();
    scroller.add_css_class("profile-editor");
    form.append(&scroller);
    editor
}

fn text_view_text(editor: &gtk::TextView) -> String {
    let buffer = editor.buffer();
    buffer
        .text(&buffer.start_iter(), &buffer.end_iter(), false)
        .to_string()
}

fn show_chat_manager(
    toast_overlay: &adw::ToastOverlay,
    state: &Rc<RefCell<AppState>>,
    repository: Option<&Rc<RefCell<Repository>>>,
    message_list: &gtk::ListBox,
) {
    let Some(window) = toast_overlay.root().and_downcast::<gtk::Window>() else {
        return;
    };
    let Some(character_id) = state
        .borrow()
        .selected_character()
        .map(|character| character.id.clone())
    else {
        toast_overlay.add_toast(adw::Toast::new("채팅을 관리할 캐릭터를 선택해 주세요."));
        return;
    };
    let dialog = gtk::Dialog::builder()
        .title("채팅 관리")
        .transient_for(&window)
        .modal(true)
        .default_width(480)
        .default_height(500)
        .build();
    dialog.add_button("닫기", gtk::ResponseType::Close);

    let content = gtk::Box::new(Orientation::Vertical, 12);
    content.set_margin_top(16);
    content.set_margin_bottom(16);
    content.set_margin_start(16);
    content.set_margin_end(16);
    let actions = gtk::Box::new(Orientation::Horizontal, 8);
    let create = gtk::Button::builder()
        .label("새 채팅")
        .icon_name("list-add-symbolic")
        .build();
    let activate = gtk::Button::with_label("선택한 채팅 열기");
    activate.add_css_class("suggested-action");
    let delete = gtk::Button::builder()
        .label("삭제")
        .icon_name("user-trash-symbolic")
        .build();
    delete.add_css_class("destructive-action");
    actions.append(&create);
    actions.append(&activate);
    actions.append(&delete);
    content.append(&actions);

    let chat_list = gtk::ListBox::new();
    chat_list.set_selection_mode(gtk::SelectionMode::Single);
    chat_list.add_css_class("boxed-list");
    let chat_ids = Rc::new(RefCell::new(Vec::new()));
    refresh_chat_list(&chat_list, &chat_ids, state, &character_id);
    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .child(&chat_list)
        .build();
    content.append(&scroller);
    dialog.content_area().append(&content);

    {
        let state = Rc::clone(state);
        let repository = repository.cloned();
        let toast_overlay = toast_overlay.clone();
        let message_list = message_list.clone();
        let chat_list = chat_list.clone();
        let chat_ids = Rc::clone(&chat_ids);
        let character_id = character_id.clone();
        create.connect_clicked(move |_| {
            let Some(repository) = &repository else {
                toast_overlay.add_toast(adw::Toast::new(
                    "SQLite가 연결되지 않아 채팅을 만들 수 없습니다.",
                ));
                return;
            };
            match repository
                .borrow_mut()
                .create_chat_for_character(&character_id)
            {
                Ok(chat) => {
                    let chat_id = chat.id.clone();
                    let loaded = repository.borrow().load_chat_context(&chat_id);
                    let mut state_ref = state.borrow_mut();
                    state_ref.add_chat(&character_id, chat);
                    let activated = loaded.is_ok_and(|loaded| {
                        state_ref.activate_chat(
                            &character_id,
                            &chat_id,
                            loaded.messages,
                            loaded.local_lore,
                            loaded.module_lore,
                            loaded.supa_memory_data,
                            loaded.hypa_v2_data,
                            loaded.hypa_v3_data,
                            loaded.bound_persona_id,
                        )
                    });
                    drop(state_ref);
                    render_messages(
                        &message_list,
                        &state
                            .borrow()
                            .selected_character()
                            .map(|character| character.messages.clone())
                            .unwrap_or_default(),
                    );
                    refresh_chat_list(&chat_list, &chat_ids, &state, &character_id);
                    toast_overlay.add_toast(adw::Toast::new(if activated {
                        "새 채팅을 만들었습니다."
                    } else {
                        "채팅은 만들었지만 새 채팅 상태를 불러오지 못했습니다."
                    }));
                }
                Err(error) => toast_overlay.add_toast(adw::Toast::new(&format!(
                    "채팅을 만들지 못했습니다: {error}"
                ))),
            }
        });
    }

    {
        let state = Rc::clone(state);
        let repository = repository.cloned();
        let toast_overlay = toast_overlay.clone();
        let message_list = message_list.clone();
        let chat_list = chat_list.clone();
        let chat_ids = Rc::clone(&chat_ids);
        let character_id = character_id.clone();
        let dialog = dialog.clone();
        activate.connect_clicked(move |_| {
            let Some(chat_id) = selected_chat_id(&chat_list, &chat_ids) else {
                toast_overlay.add_toast(adw::Toast::new("열 채팅을 선택해 주세요."));
                return;
            };
            if activate_chat(
                &state,
                repository.as_ref(),
                &toast_overlay,
                &message_list,
                &character_id,
                &chat_id,
            ) {
                dialog.close();
            }
        });
    }

    {
        let state = Rc::clone(state);
        let repository = repository.cloned();
        let toast_overlay = toast_overlay.clone();
        let message_list = message_list.clone();
        let chat_list = chat_list.clone();
        let chat_ids = Rc::clone(&chat_ids);
        let character_id = character_id.clone();
        let dialog_parent = dialog.clone();
        delete.connect_clicked(move |_| {
            let Some(chat_id) = selected_chat_id(&chat_list, &chat_ids) else {
                toast_overlay.add_toast(adw::Toast::new("삭제할 채팅을 선택해 주세요."));
                return;
            };
            let confirmation = adw::AlertDialog::builder()
                .heading("이 채팅을 삭제할까요?")
                .body("채팅에 저장된 메시지도 함께 삭제되며 되돌릴 수 없습니다.")
                .build();
            confirmation.add_response("cancel", "취소");
            confirmation.add_response("delete", "삭제");
            confirmation.set_close_response("cancel");
            confirmation.set_response_appearance("delete", adw::ResponseAppearance::Destructive);
            let state = Rc::clone(&state);
            let repository = repository.clone();
            let toast_overlay = toast_overlay.clone();
            let message_list = message_list.clone();
            let chat_list = chat_list.clone();
            let chat_ids = Rc::clone(&chat_ids);
            let character_id = character_id.clone();
            confirmation.connect_response(Some("delete"), move |_, _| {
                let Some(repository) = &repository else {
                    toast_overlay.add_toast(adw::Toast::new(
                        "SQLite가 연결되지 않아 채팅을 삭제할 수 없습니다.",
                    ));
                    return;
                };
                let current_chat_id = state
                    .borrow()
                    .selected_character()
                    .and_then(|character| character.chat_id.clone());
                match repository.borrow_mut().delete_chat(
                    &character_id,
                    &chat_id,
                    current_chat_id.as_deref(),
                ) {
                    Ok(deleted) => {
                        state.borrow_mut().replace_chats(
                            &character_id,
                            deleted.chats,
                            deleted.active_chat_id,
                            deleted.messages,
                            deleted.local_lore,
                            deleted.module_lore,
                            deleted.supa_memory_data,
                            deleted.hypa_v2_data,
                            deleted.hypa_v3_data,
                            deleted.bound_persona_id,
                        );
                        let messages = state
                            .borrow()
                            .selected_character()
                            .map(|character| character.messages.clone())
                            .unwrap_or_default();
                        render_messages(&message_list, &messages);
                        refresh_chat_list(&chat_list, &chat_ids, &state, &character_id);
                        toast_overlay.add_toast(adw::Toast::new("채팅을 삭제했습니다."));
                    }
                    Err(error) => toast_overlay.add_toast(adw::Toast::new(&format!(
                        "채팅을 삭제하지 못했습니다: {error}"
                    ))),
                }
            });
            confirmation.present(Some(&dialog_parent));
        });
    }

    {
        let state = Rc::clone(state);
        let repository = repository.cloned();
        let toast_overlay = toast_overlay.clone();
        let message_list = message_list.clone();
        let chat_ids = Rc::clone(&chat_ids);
        let character_id = character_id.clone();
        let dialog = dialog.clone();
        chat_list.connect_row_activated(move |_, row| {
            let index = row.index();
            let Some(chat_id) = (index >= 0)
                .then(|| chat_ids.borrow().get(index as usize).cloned())
                .flatten()
            else {
                return;
            };
            if activate_chat(
                &state,
                repository.as_ref(),
                &toast_overlay,
                &message_list,
                &character_id,
                &chat_id,
            ) {
                dialog.close();
            }
        });
    }

    dialog.connect_response(|dialog, _| dialog.close());
    dialog.present();
}

fn refresh_chat_list(
    chat_list: &gtk::ListBox,
    chat_ids: &Rc<RefCell<Vec<String>>>,
    state: &Rc<RefCell<AppState>>,
    character_id: &str,
) {
    while let Some(child) = chat_list.first_child() {
        chat_list.remove(&child);
    }
    chat_ids.borrow_mut().clear();
    let state = state.borrow();
    let Some(character) = state
        .characters
        .iter()
        .find(|character| character.id == character_id)
    else {
        return;
    };
    let active_id = character.chat_id.as_deref();
    for chat in &character.chats {
        let row = gtk::ListBoxRow::new();
        let content = gtk::Box::new(Orientation::Horizontal, 10);
        content.set_margin_top(10);
        content.set_margin_bottom(10);
        content.set_margin_start(12);
        content.set_margin_end(12);
        let name = gtk::Label::new(Some(&chat.name));
        name.set_hexpand(true);
        name.set_xalign(0.0);
        name.add_css_class("heading");
        content.append(&name);
        let count = gtk::Label::new(Some(&format!("메시지 {}개", chat.message_count)));
        count.add_css_class("dim-label");
        content.append(&count);
        row.set_child(Some(&content));
        chat_list.append(&row);
        chat_ids.borrow_mut().push(chat.id.clone());
        if active_id == Some(chat.id.as_str()) {
            chat_list.select_row(Some(&row));
        }
    }
}

fn selected_chat_id(
    chat_list: &gtk::ListBox,
    chat_ids: &Rc<RefCell<Vec<String>>>,
) -> Option<String> {
    let index = chat_list.selected_row()?.index();
    (index >= 0)
        .then(|| chat_ids.borrow().get(index as usize).cloned())
        .flatten()
}

fn activate_chat(
    state: &Rc<RefCell<AppState>>,
    repository: Option<&Rc<RefCell<Repository>>>,
    toast_overlay: &adw::ToastOverlay,
    message_list: &gtk::ListBox,
    character_id: &str,
    chat_id: &str,
) -> bool {
    let Some(repository) = repository else {
        toast_overlay.add_toast(adw::Toast::new(
            "SQLite가 연결되지 않아 채팅을 열 수 없습니다.",
        ));
        return false;
    };
    match repository.borrow().load_chat_context(chat_id) {
        Ok(chat) => {
            if !state.borrow_mut().activate_chat(
                character_id,
                chat_id,
                chat.messages,
                chat.local_lore,
                chat.module_lore,
                chat.supa_memory_data,
                chat.hypa_v2_data,
                chat.hypa_v3_data,
                chat.bound_persona_id,
            ) {
                toast_overlay.add_toast(adw::Toast::new("채팅 상태를 갱신하지 못했습니다."));
                return false;
            }
            let messages = state
                .borrow()
                .selected_character()
                .map(|character| character.messages.clone())
                .unwrap_or_default();
            render_messages(message_list, &messages);
            true
        }
        Err(error) => {
            toast_overlay.add_toast(adw::Toast::new(&format!("채팅을 열지 못했습니다: {error}")));
            false
        }
    }
}

fn build_character_row(character: &Character) -> gtk::ListBoxRow {
    let row = gtk::ListBoxRow::new();
    row.set_child(Some(&build_character_row_content(character)));
    row
}

fn build_character_row_content(character: &Character) -> gtk::Box {
    let content = gtk::Box::new(Orientation::Horizontal, 12);
    content.set_margin_top(10);
    content.set_margin_bottom(10);
    content.set_margin_start(10);
    content.set_margin_end(10);

    let avatar = gtk::Label::new(Some(&character.initials));
    avatar.set_width_request(42);
    avatar.set_height_request(42);
    avatar.set_halign(Align::Center);
    avatar.set_valign(Align::Center);
    avatar.add_css_class("character-avatar");
    content.append(&avatar);

    let labels = gtk::Box::new(Orientation::Vertical, 2);
    labels.set_hexpand(true);
    labels.set_valign(Align::Center);
    let name = gtk::Label::new(Some(&character.name));
    name.set_xalign(0.0);
    name.set_ellipsize(gtk::pango::EllipsizeMode::End);
    name.add_css_class("heading");
    labels.append(&name);
    let description = gtk::Label::new(Some(&character.description));
    description.set_xalign(0.0);
    description.set_ellipsize(gtk::pango::EllipsizeMode::End);
    description.add_css_class("caption");
    description.add_css_class("dim-label");
    labels.append(&description);
    content.append(&labels);

    content
}

fn render_pending_images(
    container: &gtk::Box,
    scroller: &gtk::ScrolledWindow,
    pending_images: &Rc<RefCell<Vec<PendingImage>>>,
    asset_store: &Rc<AssetStore>,
    toast_overlay: &adw::ToastOverlay,
) {
    while let Some(child) = container.first_child() {
        container.remove(&child);
    }
    let images = pending_images.borrow().clone();
    scroller.set_visible(!images.is_empty());
    for (index, image) in images.into_iter().enumerate() {
        let card = gtk::Box::new(Orientation::Vertical, 4);
        card.set_width_request(112);
        let picture = gtk::Picture::for_file(&gtk::gio::File::for_path(&image.path));
        picture.set_keep_aspect_ratio(true);
        picture.set_size_request(104, 64);
        card.append(&picture);

        let footer = gtk::Box::new(Orientation::Horizontal, 2);
        let name = gtk::Label::new(Some(&image.name));
        name.set_ellipsize(gtk::pango::EllipsizeMode::End);
        name.set_max_width_chars(12);
        name.set_tooltip_text(Some(&image.name));
        name.add_css_class("caption");
        name.set_hexpand(true);
        footer.append(&name);
        let remove = icon_button("window-close-symbolic", "첨부 제거");
        let container_for_remove = container.clone();
        let scroller = scroller.clone();
        let pending_images = Rc::clone(pending_images);
        let asset_store = Rc::clone(asset_store);
        let toast_overlay = toast_overlay.clone();
        remove.connect_clicked(move |_| {
            let removed = {
                let mut pending = pending_images.borrow_mut();
                (index < pending.len()).then(|| pending.remove(index))
            };
            if let Some(removed) = removed
                && let Err(error) = asset_store.remove(&removed.id)
            {
                toast_overlay.add_toast(adw::Toast::new(&format!(
                    "첨부 이미지를 제거하지 못했습니다: {error}"
                )));
            }
            render_pending_images(
                &container_for_remove,
                &scroller,
                &pending_images,
                &asset_store,
                &toast_overlay,
            );
        });
        footer.append(&remove);
        card.append(&footer);
        container.append(&card);
    }
}

fn render_messages(message_list: &gtk::ListBox, messages: &[Message]) {
    while let Some(child) = message_list.first_child() {
        message_list.remove(&child);
    }
    for message in messages {
        message_list.append(&build_message_row(message));
    }
}

fn build_message_row(message: &Message) -> gtk::ListBoxRow {
    build_message_row_with_body(message).0
}

fn build_message_row_with_body(message: &Message) -> (gtk::ListBoxRow, gtk::Label) {
    let row = gtk::ListBoxRow::new();
    row.set_selectable(false);
    row.set_activatable(true);
    row.set_tooltip_text(Some("메시지를 편집하거나 삭제하려면 클릭하세요."));
    row.add_css_class("message-row");

    let outer = gtk::Box::new(Orientation::Horizontal, 0);
    outer.set_margin_top(6);
    outer.set_margin_bottom(6);
    outer.set_margin_start(20);
    outer.set_margin_end(20);
    outer.set_halign(match message.role {
        Role::User => Align::End,
        Role::Character => Align::Start,
    });

    let bubble = gtk::Box::new(Orientation::Vertical, 5);
    bubble.add_css_class("message-bubble");
    match message.role {
        Role::User => bubble.add_css_class("user-message"),
        Role::Character => bubble.add_css_class("character-message"),
    }

    let speaker = gtk::Label::new(Some(match message.role {
        Role::User => "You",
        Role::Character => "Character",
    }));
    speaker.set_xalign(0.0);
    speaker.add_css_class("caption-heading");
    bubble.append(&speaker);

    let tokens = inlay_tokens(&message.content);
    if !tokens.is_empty() {
        let asset_store = AssetStore::open_default().ok();
        for token in tokens {
            match asset_store
                .as_ref()
                .ok_or_else(|| "첨부 이미지 저장소를 열 수 없습니다.".to_owned())
                .and_then(|store| {
                    store
                        .find_path(&token.id)
                        .map_err(|error| error.to_string())
                }) {
                Ok(path) => {
                    let picture = gtk::Picture::for_file(&gtk::gio::File::for_path(path));
                    picture.set_keep_aspect_ratio(true);
                    picture.set_size_request(260, 180);
                    picture.set_can_shrink(true);
                    bubble.append(&picture);
                }
                Err(error) => {
                    let missing = gtk::Label::new(Some(&format!(
                        "첨부 이미지를 표시할 수 없습니다: {error}"
                    )));
                    missing.set_wrap(true);
                    missing.set_xalign(0.0);
                    missing.add_css_class("caption");
                    missing.add_css_class("error");
                    bubble.append(&missing);
                }
            }
        }
    }
    let display_content = without_inlay_tokens(&message.content);
    let body = gtk::Label::new(Some(&display_content));
    body.set_xalign(0.0);
    body.set_wrap(true);
    body.set_wrap_mode(gtk::pango::WrapMode::WordChar);
    body.set_max_width_chars(68);
    body.set_selectable(true);
    body.set_visible(!display_content.is_empty());
    bubble.append(&body);
    outer.append(&bubble);
    row.set_child(Some(&outer));
    (row, body)
}

fn icon_button(icon_name: &str, tooltip: &str) -> gtk::Button {
    gtk::Button::builder()
        .icon_name(icon_name)
        .tooltip_text(tooltip)
        .css_classes(["flat", "circular"])
        .build()
}

fn scroll_to_bottom(adjustment: &gtk::Adjustment) {
    let adjustment = adjustment.clone();
    gtk::glib::idle_add_local_once(move || {
        adjustment.set_value((adjustment.upper() - adjustment.page_size()).max(0.0));
    });
}

fn install_css() {
    let provider = gtk::CssProvider::new();
    provider.load_from_data(include_str!("../resources/style.css"));

    if let Some(display) = gtk::gdk::Display::default() {
        gtk::style_context_add_provider_for_display(
            &display,
            &provider,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_response_policy_keeps_normal_and_continued_output_but_not_regeneration() {
        let append = GenerationKind::Append;
        let continued = GenerationKind::Continue {
            message_id: "response".into(),
            prefix: "before".into(),
        };
        let regenerated = GenerationKind::Regenerate {
            user_message_id: "user".into(),
        };
        for terminal in [
            GenerationTerminal::Cancelled,
            GenerationTerminal::Failed("network".into()),
            GenerationTerminal::Interrupted,
        ] {
            assert!(should_persist_generated_response(
                &append, &terminal, "partial"
            ));
            assert!(should_persist_generated_response(
                &continued, &terminal, "partial"
            ));
            assert!(!should_persist_generated_response(
                &regenerated,
                &terminal,
                "partial"
            ));
        }
    }

    #[test]
    fn empty_output_is_never_persisted_and_completed_regeneration_is() {
        let regenerated = GenerationKind::Regenerate {
            user_message_id: "user".into(),
        };
        assert!(!should_persist_generated_response(
            &GenerationKind::Append,
            &GenerationTerminal::Finished,
            " \n "
        ));
        assert!(should_persist_generated_response(
            &regenerated,
            &GenerationTerminal::Finished,
            "replacement"
        ));
    }
}
