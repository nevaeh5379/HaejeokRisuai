use std::error::Error;
use std::fmt::{Display, Formatter};

use crate::memory::{HypaV2State, HypaV3State};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    User,
    Character,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub content: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatSummary {
    pub id: String,
    pub name: String,
    pub message_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderSettings {
    pub provider_kind: ProviderKind,
    pub base_url: String,
    pub model: String,
    pub max_context_tokens: usize,
    pub max_output_tokens: usize,
    pub memory_mode: MemoryMode,
    pub embedding_model: String,
    pub memory_allocated_tokens: usize,
    pub memory_chunk_tokens: usize,
    pub hypa_v3: HypaV3Settings,
    pub credential_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProviderKind {
    #[default]
    OpenAiCompatible,
    Anthropic,
    Gemini,
}

impl ProviderKind {
    pub fn from_storage(value: Option<&str>) -> Self {
        match value {
            Some("anthropic") => Self::Anthropic,
            Some("gemini") => Self::Gemini,
            _ => Self::OpenAiCompatible,
        }
    }

    pub fn as_storage(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "openai-compatible",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HypaV3Settings {
    pub memory_ratio_bps: u16,
    pub extra_summarization_ratio_bps: u16,
    pub max_messages_per_summary: usize,
    pub recent_ratio_bps: u16,
    pub similar_ratio_bps: u16,
    pub query_message_count: usize,
    pub preserve_orphaned_memory: bool,
    pub do_not_summarize_user_messages: bool,
    pub enable_similarity_correction: bool,
    pub summary_chunk_separator: String,
    pub summary_prompt: String,
}

impl Default for HypaV3Settings {
    fn default() -> Self {
        Self {
            memory_ratio_bps: 2_000,
            extra_summarization_ratio_bps: 0,
            max_messages_per_summary: 6,
            recent_ratio_bps: 4_000,
            similar_ratio_bps: 4_000,
            query_message_count: 3,
            preserve_orphaned_memory: false,
            do_not_summarize_user_messages: false,
            enable_similarity_correction: false,
            summary_chunk_separator: "\\n\\n".into(),
            summary_prompt: String::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MemoryMode {
    #[default]
    Supa,
    Hypa,
    HypaV2,
    HypaV3,
}

impl MemoryMode {
    pub fn from_storage(value: Option<&str>) -> Self {
        match value {
            Some("hypa") => Self::Hypa,
            Some("hypa-v2") => Self::HypaV2,
            Some("hypa-v3") => Self::HypaV3,
            _ => Self::Supa,
        }
    }

    pub fn as_storage(self) -> &'static str {
        match self {
            Self::Supa => "supa",
            Self::Hypa => "hypa",
            Self::HypaV2 => "hypa-v2",
            Self::HypaV3 => "hypa-v3",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresetSummary {
    pub id: String,
    pub name: String,
    pub api_type: String,
    pub model: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoreEntry {
    pub source_index: Option<usize>,
    pub id: Option<String>,
    pub key: String,
    pub second_key: String,
    pub insertion_order: i64,
    pub name: String,
    pub content: String,
    pub mode: String,
    pub always_active: bool,
    pub selective: bool,
    pub use_regex: bool,
    pub case_sensitive: bool,
    pub activation_percent: Option<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoreSettings {
    pub token_budget: usize,
    pub scan_depth: usize,
    pub recursive_scanning: bool,
    pub full_word_matching: bool,
}

impl Default for LoreSettings {
    fn default() -> Self {
        Self {
            token_budget: 8_000,
            scan_depth: 5,
            recursive_scanning: true,
            full_word_matching: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Character {
    pub id: String,
    pub chat_id: Option<String>,
    pub chats: Vec<ChatSummary>,
    pub name: String,
    pub description: String,
    pub initials: String,
    pub messages: Vec<Message>,
    pub profile: CharacterProfile,
    pub global_lore: Vec<LoreEntry>,
    pub local_lore: Vec<LoreEntry>,
    pub module_lore: Vec<LoreEntry>,
    pub lore_settings: LoreSettings,
    pub supa_memory_enabled: bool,
    pub supa_memory_data: Option<String>,
    pub hypa_v2_data: Option<HypaV2State>,
    pub hypa_v3_data: Option<HypaV3State>,
    pub persona: Persona,
    pub bound_persona_id: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Persona {
    pub source_index: usize,
    pub id: Option<String>,
    pub name: String,
    pub prompt: String,
    pub note: String,
    pub icon: String,
    pub large_portrait: bool,
    pub embedded_lore: Vec<LoreEntry>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CharacterProfile {
    pub first_message: String,
    pub description: String,
    pub personality: String,
    pub scenario: String,
    pub system_prompt: String,
    pub post_history_instructions: String,
    pub example_message: String,
    pub creator_notes: String,
}

#[derive(Debug, Eq, PartialEq)]
pub enum SubmitError {
    NoCharacterSelected,
    EmptyMessage,
}

impl Display for SubmitError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoCharacterSelected => formatter.write_str("선택된 캐릭터가 없습니다."),
            Self::EmptyMessage => formatter.write_str("메시지를 입력해 주세요."),
        }
    }
}

impl Error for SubmitError {}

#[derive(Debug)]
pub struct AppState {
    pub characters: Vec<Character>,
    pub personas: Vec<Persona>,
    pub selected_persona: usize,
    selected: Option<usize>,
}

impl AppState {
    pub fn demo() -> Self {
        Self {
            characters: vec![
                Character {
                    id: "demo-risu".into(),
                    chat_id: Some("demo-risu-chat".into()),
                    chats: vec![ChatSummary {
                        id: "demo-risu-chat".into(),
                        name: "Chat 1".into(),
                        message_count: 2,
                    }],
                    name: "Risu".into(),
                    description: "Native GTK preview".into(),
                    initials: "R".into(),
                    messages: vec![
                        Message {
                            id: "demo-risu-message-1".into(),
                            role: Role::Character,
                            content: "안녕하세요! RisuAI의 GTK 4 네이티브 포팅을 시작했어요.".into(),
                        },
                        Message {
                            id: "demo-risu-message-2".into(),
                            role: Role::Character,
                            content: "현재는 UI와 상태 모델을 검증하는 단계이며, AI 공급자는 아직 연결되지 않았습니다.".into(),
                        },
                    ],
                    profile: CharacterProfile::default(),
                    global_lore: Vec::new(),
                    local_lore: Vec::new(),
                    module_lore: Vec::new(),
                    lore_settings: LoreSettings::default(),
                    supa_memory_enabled: false,
                    supa_memory_data: None,
                    hypa_v2_data: None,
                    hypa_v3_data: None,
                    persona: Persona {
                        name: "User".into(),
                        ..Persona::default()
                    },
                    bound_persona_id: None,
                },
                Character {
                    id: "demo-aria".into(),
                    chat_id: Some("demo-aria-chat".into()),
                    chats: vec![ChatSummary {
                        id: "demo-aria-chat".into(),
                        name: "Chat 1".into(),
                        message_count: 1,
                    }],
                    name: "Aria".into(),
                    description: "Creative writing assistant".into(),
                    initials: "A".into(),
                    messages: vec![Message {
                        id: "demo-aria-message-1".into(),
                        role: Role::Character,
                        content: "새로운 이야기를 함께 만들어 볼까요?".into(),
                    }],
                    profile: CharacterProfile::default(),
                    global_lore: Vec::new(),
                    local_lore: Vec::new(),
                    module_lore: Vec::new(),
                    lore_settings: LoreSettings::default(),
                    supa_memory_enabled: false,
                    supa_memory_data: None,
                    hypa_v2_data: None,
                    hypa_v3_data: None,
                    persona: Persona {
                        name: "User".into(),
                        ..Persona::default()
                    },
                    bound_persona_id: None,
                },
                Character {
                    id: "demo-research-lab".into(),
                    chat_id: Some("demo-research-lab-chat".into()),
                    chats: vec![ChatSummary {
                        id: "demo-research-lab-chat".into(),
                        name: "Chat 1".into(),
                        message_count: 1,
                    }],
                    name: "Research Lab".into(),
                    description: "Group chat".into(),
                    initials: "RL".into(),
                    messages: vec![Message {
                        id: "demo-research-message-1".into(),
                        role: Role::Character,
                        content: "그룹 채팅을 위한 네이티브 화면 자리입니다.".into(),
                    }],
                    profile: CharacterProfile::default(),
                    global_lore: Vec::new(),
                    local_lore: Vec::new(),
                    module_lore: Vec::new(),
                    lore_settings: LoreSettings::default(),
                    supa_memory_enabled: false,
                    supa_memory_data: None,
                    hypa_v2_data: None,
                    hypa_v3_data: None,
                    persona: Persona {
                        name: "User".into(),
                        ..Persona::default()
                    },
                    bound_persona_id: None,
                },
            ],
            personas: vec![Persona {
                name: "User".into(),
                ..Persona::default()
            }],
            selected_persona: 0,
            selected: Some(0),
        }
    }

    pub fn from_characters(
        characters: Vec<Character>,
        personas: Vec<Persona>,
        selected_persona: usize,
    ) -> Self {
        let selected = (!characters.is_empty()).then_some(0);
        Self {
            characters,
            personas,
            selected_persona,
            selected,
        }
    }

    pub fn selected_index(&self) -> Option<usize> {
        self.selected
    }

    pub fn select(&mut self, index: usize) -> bool {
        if index >= self.characters.len() {
            return false;
        }

        self.selected = Some(index);
        true
    }

    pub fn selected_character(&self) -> Option<&Character> {
        self.selected.and_then(|index| self.characters.get(index))
    }

    pub fn validate_message(&self, content: &str) -> Result<String, SubmitError> {
        let content = content.trim();
        if content.is_empty() {
            return Err(SubmitError::EmptyMessage);
        }
        if self.selected_character().is_none() {
            return Err(SubmitError::NoCharacterSelected);
        }
        Ok(content.to_owned())
    }

    pub fn append_message(
        &mut self,
        character_id: &str,
        chat_id: String,
        message: Message,
    ) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        if let Some(chat) = character.chats.iter_mut().find(|chat| chat.id == chat_id) {
            chat.message_count += 1;
        } else {
            character.chats.push(ChatSummary {
                id: chat_id.clone(),
                name: format!("Chat {}", character.chats.len() + 1),
                message_count: 1,
            });
        }
        if character.chat_id.is_none() {
            character.chat_id = Some(chat_id.clone());
        }
        if character.chat_id.as_deref() == Some(chat_id.as_str()) {
            character.messages.push(message);
        }
        true
    }

    pub fn update_message(&mut self, character_id: &str, chat_id: &str, message: Message) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        if character.chat_id.as_deref() != Some(chat_id) {
            return character.chats.iter().any(|chat| chat.id == chat_id);
        }
        let Some(existing) = character
            .messages
            .iter_mut()
            .find(|existing| existing.id == message.id)
        else {
            return false;
        };
        *existing = message;
        true
    }

    pub fn replace_tail_after(
        &mut self,
        character_id: &str,
        chat_id: &str,
        user_message_id: &str,
        removed_count: usize,
        message: Message,
    ) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        let active_anchor =
            if character.chat_id.as_deref() == Some(chat_id) {
                let Some(anchor) = character.messages.iter().position(|existing| {
                    existing.id == user_message_id && existing.role == Role::User
                }) else {
                    return false;
                };
                Some(anchor)
            } else {
                None
            };
        let Some(chat) = character.chats.iter_mut().find(|chat| chat.id == chat_id) else {
            return false;
        };
        chat.message_count = chat
            .message_count
            .saturating_sub(removed_count)
            .saturating_add(1);
        if let Some(anchor) = active_anchor {
            character.messages.truncate(anchor + 1);
            character.messages.push(message);
        }
        true
    }

    #[allow(clippy::too_many_arguments)]
    pub fn delete_messages(
        &mut self,
        character_id: &str,
        chat_id: &str,
        message_ids: &[String],
        supa_memory_data: Option<String>,
        hypa_v2_data: Option<HypaV2State>,
        hypa_v3_data: Option<HypaV3State>,
    ) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        let Some(chat) = character.chats.iter_mut().find(|chat| chat.id == chat_id) else {
            return false;
        };
        chat.message_count = chat.message_count.saturating_sub(message_ids.len());
        if character.chat_id.as_deref() != Some(chat_id) {
            return true;
        }
        let ids = message_ids
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        character
            .messages
            .retain(|message| !ids.contains(message.id.as_str()));
        character.supa_memory_data = supa_memory_data;
        character.hypa_v2_data = hypa_v2_data;
        character.hypa_v3_data = hypa_v3_data;
        true
    }

    pub fn update_character(
        &mut self,
        character_id: &str,
        name: String,
        profile: CharacterProfile,
        supa_memory_enabled: bool,
    ) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        character.name = name;
        character.initials = initials(&character.name);
        character.profile = profile;
        character.supa_memory_enabled = supa_memory_enabled;
        character.description = if character.profile.description.trim().is_empty() {
            "Character".into()
        } else {
            character.profile.description.clone()
        };
        character
            .messages
            .retain(|message| !message.id.starts_with("virtual-first-message:"));
        if !character.profile.first_message.is_empty() {
            character.messages.insert(
                0,
                Message {
                    id: format!("virtual-first-message:{}", character.id),
                    role: Role::Character,
                    content: character.profile.first_message.clone(),
                },
            );
        }
        true
    }

    #[allow(clippy::too_many_arguments)]
    pub fn activate_chat(
        &mut self,
        character_id: &str,
        chat_id: &str,
        mut messages: Vec<Message>,
        local_lore: Vec<LoreEntry>,
        module_lore: Vec<LoreEntry>,
        supa_memory_data: Option<String>,
        hypa_v2_data: Option<HypaV2State>,
        hypa_v3_data: Option<HypaV3State>,
        bound_persona_id: Option<String>,
    ) -> bool {
        let persona = resolve_persona(
            &self.personas,
            self.selected_persona,
            bound_persona_id.as_deref(),
        );
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        if !character.chats.iter().any(|chat| chat.id == chat_id) {
            return false;
        }
        prepend_virtual_first_message(character, &mut messages);
        character.chat_id = Some(chat_id.to_owned());
        character.messages = messages;
        character.local_lore = local_lore;
        character.module_lore = module_lore;
        character.supa_memory_data = supa_memory_data;
        character.hypa_v2_data = hypa_v2_data;
        character.hypa_v3_data = hypa_v3_data;
        character.persona = persona;
        character.bound_persona_id = bound_persona_id;
        true
    }

    pub fn update_personas(
        &mut self,
        personas: Vec<Persona>,
        selected_index: usize,
        character_id: &str,
        chat_id: &str,
        bound_persona_id: Option<String>,
    ) -> bool {
        if personas.is_empty() || selected_index >= personas.len() {
            return false;
        }
        self.personas = personas;
        self.selected_persona = selected_index;
        for character in &mut self.characters {
            if character.id == character_id && character.chat_id.as_deref() == Some(chat_id) {
                character.bound_persona_id = bound_persona_id.clone();
            }
            character.persona = resolve_persona(
                &self.personas,
                self.selected_persona,
                character.bound_persona_id.as_deref(),
            );
        }
        true
    }

    pub fn update_supa_memory(
        &mut self,
        character_id: &str,
        chat_id: &str,
        data: Option<String>,
    ) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        if character.chat_id.as_deref() != Some(chat_id) {
            return false;
        }
        character.supa_memory_data = data;
        true
    }

    pub fn update_hypa_v2_memory(
        &mut self,
        character_id: &str,
        chat_id: &str,
        data: Option<HypaV2State>,
    ) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        if character.chat_id.as_deref() != Some(chat_id) {
            return false;
        }
        character.hypa_v2_data = data;
        true
    }

    pub fn update_hypa_v3_memory(
        &mut self,
        character_id: &str,
        chat_id: &str,
        data: Option<HypaV3State>,
    ) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        if character.chat_id.as_deref() != Some(chat_id) {
            return false;
        }
        character.hypa_v3_data = data;
        true
    }

    pub fn add_chat(&mut self, character_id: &str, chat: ChatSummary) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        if character
            .chats
            .iter()
            .any(|existing| existing.id == chat.id)
        {
            return false;
        }
        character.chats.push(chat);
        true
    }

    pub fn update_lorebooks(
        &mut self,
        character_id: &str,
        chat_id: &str,
        global_lore: Vec<LoreEntry>,
        local_lore: Vec<LoreEntry>,
        lore_settings: LoreSettings,
    ) -> bool {
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        if character.chat_id.as_deref() != Some(chat_id) {
            return false;
        }
        character.global_lore = global_lore;
        character.local_lore = local_lore;
        character.lore_settings = lore_settings;
        true
    }

    #[allow(clippy::too_many_arguments)]
    pub fn replace_chats(
        &mut self,
        character_id: &str,
        chats: Vec<ChatSummary>,
        active_chat_id: String,
        mut messages: Vec<Message>,
        local_lore: Vec<LoreEntry>,
        module_lore: Vec<LoreEntry>,
        supa_memory_data: Option<String>,
        hypa_v2_data: Option<HypaV2State>,
        hypa_v3_data: Option<HypaV3State>,
        bound_persona_id: Option<String>,
    ) -> bool {
        let persona = resolve_persona(
            &self.personas,
            self.selected_persona,
            bound_persona_id.as_deref(),
        );
        let Some(character) = self
            .characters
            .iter_mut()
            .find(|character| character.id == character_id)
        else {
            return false;
        };
        prepend_virtual_first_message(character, &mut messages);
        character.chats = chats;
        character.chat_id = Some(active_chat_id);
        character.messages = messages;
        character.local_lore = local_lore;
        character.module_lore = module_lore;
        character.supa_memory_data = supa_memory_data;
        character.hypa_v2_data = hypa_v2_data;
        character.hypa_v3_data = hypa_v3_data;
        character.persona = persona;
        character.bound_persona_id = bound_persona_id;
        true
    }
}

fn resolve_persona(personas: &[Persona], selected_index: usize, bound_id: Option<&str>) -> Persona {
    bound_id
        .and_then(|id| {
            personas
                .iter()
                .find(|persona| persona.id.as_deref() == Some(id))
        })
        .or_else(|| personas.get(selected_index))
        .or_else(|| personas.first())
        .cloned()
        .unwrap_or_else(|| Persona {
            name: "User".into(),
            ..Persona::default()
        })
}

fn prepend_virtual_first_message(character: &Character, messages: &mut Vec<Message>) {
    if !character.profile.first_message.is_empty()
        && messages
            .first()
            .is_none_or(|message| message.content != character.profile.first_message)
    {
        messages.insert(
            0,
            Message {
                id: format!("virtual-first-message:{}", character.id),
                role: Role::Character,
                content: character.profile.first_message.clone(),
            },
        );
    }
}

fn initials(name: &str) -> String {
    let initials = name
        .split_whitespace()
        .filter_map(|word| word.chars().next())
        .take(2)
        .collect::<String>();
    if initials.is_empty() {
        "?".into()
    } else {
        initials
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_state_starts_with_a_selected_character() {
        let state = AppState::demo();
        assert_eq!(state.selected_index(), Some(0));
        assert_eq!(
            state
                .selected_character()
                .map(|character| character.name.as_str()),
            Some("Risu")
        );
    }

    #[test]
    fn selecting_an_unknown_character_keeps_the_current_selection() {
        let mut state = AppState::demo();
        assert!(!state.select(100));
        assert_eq!(state.selected_index(), Some(0));
    }

    #[test]
    fn validating_a_message_trims_it_without_mutating_state() {
        let state = AppState::demo();
        let previous_len = state.selected_character().unwrap().messages.len();
        let content = state.validate_message("  hello native Risu  ").unwrap();

        assert_eq!(content, "hello native Risu");
        assert_eq!(
            state.selected_character().unwrap().messages.len(),
            previous_len
        );
    }

    #[test]
    fn submitting_blank_text_is_rejected() {
        let state = AppState::demo();
        assert_eq!(
            state.validate_message(" \n\t "),
            Err(SubmitError::EmptyMessage)
        );
    }

    #[test]
    fn appending_a_persisted_message_updates_the_active_chat() {
        let mut state = AppState::demo();
        let message = Message {
            id: "persisted-message".into(),
            role: Role::User,
            content: "saved".into(),
        };

        assert!(state.append_message("demo-risu", "demo-risu-chat".into(), message.clone()));
        let selected = state.selected_character().unwrap();
        assert_eq!(selected.chat_id.as_deref(), Some("demo-risu-chat"));
        assert_eq!(selected.messages.last(), Some(&message));
        assert_eq!(selected.chats[0].message_count, 3);
    }

    #[test]
    fn a_late_response_does_not_replace_or_append_to_a_different_active_chat() {
        let mut state = AppState::demo();
        state.characters[0].chats.push(ChatSummary {
            id: "second-chat".into(),
            name: "Chat 2".into(),
            message_count: 0,
        });
        assert!(state.activate_chat(
            "demo-risu",
            "second-chat",
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            None,
            None,
            None,
        ));
        let late = Message {
            id: "late-response".into(),
            role: Role::Character,
            content: "for the first chat".into(),
        };

        assert!(state.append_message("demo-risu", "demo-risu-chat".into(), late));
        let character = &state.characters[0];
        assert_eq!(character.chat_id.as_deref(), Some("second-chat"));
        assert!(character.messages.is_empty());
        assert_eq!(character.chats[0].message_count, 3);
    }

    #[test]
    fn appending_by_character_id_does_not_follow_a_later_selection() {
        let mut state = AppState::demo();
        assert!(state.select(1));
        let message = Message {
            id: "late-response".into(),
            role: Role::Character,
            content: "for Risu".into(),
        };

        assert!(state.append_message("demo-risu", "demo-risu-chat".into(), message.clone()));
        assert_eq!(state.characters[0].messages.last(), Some(&message));
        assert_ne!(state.characters[1].messages.last(), Some(&message));
    }

    #[test]
    fn lorebook_updates_are_bound_to_the_original_active_chat() {
        let mut state = AppState::demo();
        let lore = LoreEntry {
            source_index: None,
            id: Some("new-lore".into()),
            key: "dragon".into(),
            second_key: String::new(),
            insertion_order: 100,
            name: "Dragon".into(),
            content: "A dragon".into(),
            mode: "normal".into(),
            always_active: false,
            selective: false,
            use_regex: false,
            case_sensitive: false,
            activation_percent: None,
        };
        let settings = LoreSettings {
            token_budget: 500,
            ..LoreSettings::default()
        };
        assert!(state.update_lorebooks(
            "demo-risu",
            "demo-risu-chat",
            vec![lore.clone()],
            vec![lore.clone()],
            settings.clone(),
        ));
        assert_eq!(state.characters[0].global_lore, vec![lore.clone()]);
        assert_eq!(state.characters[0].lore_settings, settings);

        state.characters[0].chats.push(ChatSummary {
            id: "second-chat".into(),
            name: "Chat 2".into(),
            message_count: 0,
        });
        assert!(state.activate_chat(
            "demo-risu",
            "second-chat",
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            None,
            None,
            None,
        ));
        assert!(!state.update_lorebooks(
            "demo-risu",
            "demo-risu-chat",
            Vec::new(),
            Vec::new(),
            LoreSettings::default(),
        ));
        assert_eq!(state.characters[0].global_lore, vec![lore]);
    }

    #[test]
    fn supa_memory_updates_are_bound_to_the_original_active_chat() {
        let mut state = AppState::demo();
        assert!(state.update_supa_memory(
            "demo-risu",
            "demo-risu-chat",
            Some("message-2\nsummary".into()),
        ));
        assert_eq!(
            state.characters[0].supa_memory_data.as_deref(),
            Some("message-2\nsummary")
        );

        state.characters[0].chats.push(ChatSummary {
            id: "second-chat".into(),
            name: "Chat 2".into(),
            message_count: 0,
        });
        assert!(state.activate_chat(
            "demo-risu",
            "second-chat",
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            None,
            None,
            None,
        ));
        assert!(!state.update_supa_memory(
            "demo-risu",
            "demo-risu-chat",
            Some("stale\nsummary".into()),
        ));
        assert!(state.characters[0].supa_memory_data.is_none());
    }

    #[test]
    fn continuing_replaces_the_persisted_message_without_changing_the_count() {
        let mut state = AppState::demo();
        let message_id = state.characters[0].messages.last().unwrap().id.clone();
        let count = state.characters[0].chats[0].message_count;
        let replacement = Message {
            id: message_id,
            role: Role::Character,
            content: "continued response".into(),
        };

        assert!(state.update_message("demo-risu", "demo-risu-chat", replacement.clone()));
        assert_eq!(state.characters[0].messages.last(), Some(&replacement));
        assert_eq!(state.characters[0].chats[0].message_count, count);
    }

    #[test]
    fn regenerating_replaces_the_active_tail_and_adjusts_the_count() {
        let mut state = AppState::demo();
        let anchor = Message {
            id: "user-anchor".into(),
            role: Role::User,
            content: "prompt".into(),
        };
        state.characters[0].messages.push(anchor.clone());
        state.characters[0].messages.push(Message {
            id: "old-one".into(),
            role: Role::Character,
            content: "old one".into(),
        });
        state.characters[0].messages.push(Message {
            id: "old-two".into(),
            role: Role::Character,
            content: "old two".into(),
        });
        state.characters[0].chats[0].message_count += 3;
        let replacement = Message {
            id: "new-answer".into(),
            role: Role::Character,
            content: "new answer".into(),
        };

        assert!(state.replace_tail_after(
            "demo-risu",
            "demo-risu-chat",
            &anchor.id,
            2,
            replacement.clone(),
        ));
        assert_eq!(
            state.characters[0]
                .messages
                .iter()
                .rev()
                .take(2)
                .cloned()
                .collect::<Vec<_>>(),
            vec![replacement, anchor]
        );
        assert_eq!(state.characters[0].chats[0].message_count, 4);
    }

    #[test]
    fn deleting_persisted_messages_updates_active_rows_count_and_memory() {
        let mut state = AppState::demo();
        let removed = state.characters[0].messages[1].id.clone();
        state.characters[0].supa_memory_data = Some("old".into());
        state.characters[0].hypa_v2_data = Some(HypaV2State::default());
        state.characters[0].hypa_v3_data = Some(HypaV3State::default());

        assert!(state.delete_messages(
            "demo-risu",
            "demo-risu-chat",
            std::slice::from_ref(&removed),
            None,
            None,
            None,
        ));
        assert_eq!(state.characters[0].messages.len(), 1);
        assert!(
            state.characters[0]
                .messages
                .iter()
                .all(|message| message.id != removed)
        );
        assert_eq!(state.characters[0].chats[0].message_count, 1);
        assert!(state.characters[0].supa_memory_data.is_none());
        assert!(state.characters[0].hypa_v2_data.is_none());
        assert!(state.characters[0].hypa_v3_data.is_none());
    }

    #[test]
    fn persona_updates_respect_chat_binding_and_global_fallback() {
        let mut state = AppState::demo();
        let personas = vec![
            Persona {
                id: Some("global".into()),
                name: "Global".into(),
                ..Persona::default()
            },
            Persona {
                id: Some("bound".into()),
                name: "Bound".into(),
                ..Persona::default()
            },
        ];
        assert!(state.update_personas(
            personas.clone(),
            0,
            "demo-risu",
            "demo-risu-chat",
            Some("bound".into()),
        ));
        assert_eq!(state.characters[0].persona.name, "Bound");
        assert_eq!(state.characters[1].persona.name, "Global");
        assert!(state.update_personas(personas, 1, "demo-risu", "demo-risu-chat", None,));
        assert_eq!(state.characters[0].persona.name, "Bound");
        assert_eq!(state.characters[1].persona.name, "Bound");
    }
}
