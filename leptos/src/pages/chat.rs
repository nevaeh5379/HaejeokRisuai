use crate::components::common::button::{Button, ButtonVariant};
use crate::components::common::icon::{Icon, IconName};
use crate::models::chat::MessageRole;
use crate::state::app_state::AppState;
use leptos::prelude::*;
use leptos_router::components::A;

#[component]
pub fn ChatPage() -> impl IntoView {
    let state = expect_context::<AppState>();

    let selected_char = state.chat.selected_char_id;
    let messages = state.chat.messages;

    view! {
        <div style="height: 100%; display: flex; flex-direction: column; max-width: 56rem; margin: 0 auto; width: 100%;">
            // Active Character Header
            <div style="background-color: var(--risu-theme-darkbg); border: 1px solid var(--risu-theme-darkborderc); border-radius: var(--risu-radius-md); padding: 0.75rem 1rem; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between;">
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                    <div style="width: 2.25rem; height: 2.25rem; border-radius: var(--risu-radius-full); background: linear-gradient(135deg, var(--risu-primary), var(--risu-accent)); display: flex; align-items: center; justify-content: center; font-size: 1rem;">
                        "💬"
                    </div>
                    <div>
                        <div style="font-weight: 700; font-size: 0.9375rem;">
                            {move || match selected_char.get() {
                                Some(id) => format!("Character ID: {}", id),
                                None => "No Character Selected".to_string(),
                            }}
                        </div>
                        <div style="font-size: 0.75rem; color: var(--risu-theme-textcolor2);">
                            "Active Chat Session (Windowed message paging scaffold)"
                        </div>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                    <A href="/characters">
                        <Button variant=ButtonVariant::Ghost class="btn-icon">
                            <Icon name=IconName::Users size=18 />
                        </Button>
                    </A>
                    <Button
                        variant=ButtonVariant::Ghost
                        class="btn-icon"
                        disabled=true
                    >
                        <Icon name=IconName::Trash size=18 />
                    </Button>
                </div>
            </div>

            // Chat Messages Container
            <div class="card" style="flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 0;">
                <div class="chat-message-list">
                    {move || {
                        let msgs = messages.get();
                        if msgs.is_empty() {
                            view! {
                                <div style="margin: auto; text-align: center; color: var(--risu-theme-textcolor2); padding: 2rem;">
                                    <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">"💬"</div>
                                    <h3 style="font-size: 1.125rem; font-weight: 700; color: var(--risu-theme-textcolor); margin-bottom: 0.25rem;">
                                        "No Messages In Active Window"
                                    </h3>
                                    <p style="font-size: 0.8125rem;">
                                        "Select a character from the catalog or load an existing session to view messages."
                                    </p>
                                </div>
                            }.into_any()
                        } else {
                            view! {
                                <For
                                    each=move || messages.get()
                                    key=|m| format!("{}-{:?}", m.data, m.time)
                                    children=move |m| {
                                        let bubble_class = match m.role {
                                            MessageRole::User => "chat-bubble chat-bubble-user",
                                            MessageRole::Char => "chat-bubble chat-bubble-char chat-bubble-assistant",
                                        };
                                        let display_name = m.name.clone().unwrap_or_else(|| m.role.as_str().to_string());

                                        view! {
                                            <div class=bubble_class>
                                                <div style="font-size: 0.75rem; font-weight: 700; opacity: 0.7; margin-bottom: 0.25rem;">
                                                    {display_name}
                                                </div>
                                                <div style="white-space: pre-wrap; line-height: 1.5;">
                                                    {m.data}
                                                </div>
                                            </div>
                                        }
                                    }
                                />
                            }.into_any()
                        }
                    }}
                </div>

                // Message Composer Area (Disabled with clear migration boundary message)
                <div class="chat-input-area">
                    <textarea
                        class="input-control"
                        placeholder="Message sending & generation pipeline are not yet migrated (read-only scaffold)"
                        disabled=true
                        style="min-height: 2.75rem; max-height: 8rem; resize: none; padding: 0.625rem 0.75rem; opacity: 0.6; cursor: not-allowed;"
                    ></textarea>
                    <Button
                        variant=ButtonVariant::Primary
                        disabled=true
                    >
                        <Icon name=IconName::Send size=18 />
                        <span>"Send"</span>
                    </Button>
                </div>
            </div>
        </div>
    }
}
