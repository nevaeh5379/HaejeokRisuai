use crate::models::settings::ThemePreset;
use gloo_storage::{LocalStorage, Storage};
use leptos::prelude::*;

const THEME_STORAGE_KEY: &str = "risuai_leptos_theme";

#[derive(Debug, Clone, Copy)]
pub struct ThemeState {
    pub current_theme: RwSignal<ThemePreset>,
}

impl Default for ThemeState {
    fn default() -> Self {
        Self::new()
    }
}

impl ThemeState {
    pub fn new() -> Self {
        let initial_theme = LocalStorage::get::<String>(THEME_STORAGE_KEY)
            .ok()
            .and_then(|name| match name.as_str() {
                "dark" => Some(ThemePreset::Dark),
                "light" => Some(ThemePreset::Light),
                "cherry" => Some(ThemePreset::Cherry),
                "galaxy" => Some(ThemePreset::Galaxy),
                "ocean" => Some(ThemePreset::Ocean),
                "realblack" => Some(ThemePreset::RealBlack),
                _ => Some(ThemePreset::Default),
            })
            .unwrap_or(ThemePreset::Default);

        let current_theme = RwSignal::new(initial_theme);
        apply_theme_to_dom(initial_theme);

        Self { current_theme }
    }

    pub fn set_theme(&self, theme: ThemePreset) {
        self.current_theme.set(theme);
        let _ = LocalStorage::set(THEME_STORAGE_KEY, theme.name());
        apply_theme_to_dom(theme);
    }
}

fn apply_theme_to_dom(theme: ThemePreset) {
    if let Some(window) = web_sys::window() {
        if let Some(document) = window.document() {
            if let Some(root) = document.document_element() {
                let _ = root.set_attribute("data-theme", theme.name());
            }
        }
    }
}
