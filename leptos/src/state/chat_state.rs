use crate::models::chat::Message;
use leptos::prelude::*;

#[derive(Debug, Clone, Copy)]
pub struct ChatState {
    pub selected_char_id: RwSignal<Option<String>>,
    pub active_chat_id: RwSignal<Option<String>>,
    pub messages: RwSignal<Vec<Message>>,
    pub is_generating: RwSignal<bool>,
    pub has_more_messages: RwSignal<bool>,
    pub message_offset: RwSignal<usize>,
    pub message_total: RwSignal<usize>,
}

impl Default for ChatState {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatState {
    pub fn new() -> Self {
        Self {
            selected_char_id: RwSignal::new(None),
            active_chat_id: RwSignal::new(None),
            messages: RwSignal::new(Vec::new()),
            is_generating: RwSignal::new(false),
            has_more_messages: RwSignal::new(false),
            message_offset: RwSignal::new(0),
            message_total: RwSignal::new(0),
        }
    }

    pub fn select_character(&self, char_id: Option<String>) {
        self.selected_char_id.set(char_id);
        // Clear message window when switching characters to minimize memory footprint
        self.messages.set(Vec::new());
        self.active_chat_id.set(None);
        self.has_more_messages.set(false);
        self.message_offset.set(0);
        self.message_total.set(0);
    }

    pub fn set_messages(&self, messages: Vec<Message>) {
        self.messages.set(messages);
    }

    pub fn prepend_paged_messages(&self, older_messages: Vec<Message>) {
        self.messages.update(|current| {
            let mut combined = older_messages;
            combined.append(current);
            *current = combined;
        });
    }

    pub fn append_message(&self, message: Message) {
        self.messages.update(|list| list.push(message));
    }
}
