use leptos::prelude::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToastType {
    Success,
    Warning,
    Error,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToastInfo {
    pub id: u64,
    pub message: String,
    pub toast_type: ToastType,
}

#[derive(Debug, Clone, Copy)]
pub struct UiState {
    pub sidebar_open: RwSignal<bool>,
    pub toasts: RwSignal<Vec<ToastInfo>>,
    next_toast_id: RwSignal<u64>,
}

impl Default for UiState {
    fn default() -> Self {
        Self::new()
    }
}

impl UiState {
    pub fn new() -> Self {
        Self {
            sidebar_open: RwSignal::new(false),
            toasts: RwSignal::new(Vec::new()),
            next_toast_id: RwSignal::new(1),
        }
    }

    pub fn toggle_sidebar(&self) {
        self.sidebar_open.update(|open| *open = !*open);
    }

    pub fn close_sidebar(&self) {
        self.sidebar_open.set(false);
    }

    pub fn open_sidebar(&self) {
        self.sidebar_open.set(true);
    }

    pub fn toast(&self, message: impl Into<String>, toast_type: ToastType) {
        let id = self.next_toast_id.get();
        self.next_toast_id.set(id + 1);

        let new_toast = ToastInfo {
            id,
            message: message.into(),
            toast_type,
        };

        self.toasts.update(|list| list.push(new_toast));
    }

    pub fn dismiss_toast(&self, id: u64) {
        self.toasts.update(|list| list.retain(|t| t.id != id));
    }
}
