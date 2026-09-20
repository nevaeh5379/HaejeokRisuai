use gtk::prelude::*;
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

mod background_effect;
mod decoration;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundBlurSupport {
    Standard,
    KwinLegacy,
    #[default]
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxWindowCapabilities {
    pub wayland: bool,
    pub server_side_decoration: bool,
    pub background_blur: BackgroundBlurSupport,
}

static CAPABILITIES: OnceLock<Mutex<LinuxWindowCapabilities>> = OnceLock::new();

fn capability_store() -> &'static Mutex<LinuxWindowCapabilities> {
    CAPABILITIES.get_or_init(|| Mutex::new(LinuxWindowCapabilities::default()))
}
pub fn capabilities() -> LinuxWindowCapabilities {
    capability_store()
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default()
}

fn set_capabilities(value: LinuxWindowCapabilities) {
    if let Ok(mut capabilities) = capability_store().lock() {
        *capabilities = value;
    }
}

fn supports_native_window(label: &str) -> bool {
    label == "main" || label.starts_with("chat-window-")
}

pub fn set_risu_native_appearance<R: Runtime>(
    app: &AppHandle<R>,
    dark: bool,
) -> Result<(), String> {
    for window in app.webview_windows().into_values() {
        if !supports_native_window(window.label()) {
            continue;
        }
        let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
        if let Some(settings) = gtk_window.settings() {
            settings.set_gtk_application_prefer_dark_theme(dark);
        }
    }
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("linux-wayland")
        .on_window_ready(|window| {
            if !supports_native_window(window.label()) {
                return;
            }

            match background_effect::install(&window) {
                Ok(capabilities) => {
                    if window.label() == "main" {
                        set_capabilities(capabilities.clone());
                    }
                    eprintln!(
                        "[Linux Wayland] {}: decoration={}, blur={:?}",
                        window.label(),
                        capabilities.server_side_decoration,
                        capabilities.background_blur
                    );
                }
                Err(error) => {
                    if window.label() == "main" {
                        set_capabilities(LinuxWindowCapabilities::default());
                    }
                    if let Ok(gtk_window) = window.gtk_window() {
                        gtk_window.show_all();
                    }
                    eprintln!(
                        "[Linux Wayland] Failed to initialize {}; keeping GTK CSD: {error}",
                        window.label()
                    );
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_capabilities_do_not_claim_wayland_features() {
        assert_eq!(
            LinuxWindowCapabilities::default(),
            LinuxWindowCapabilities {
                wayland: false,
                server_side_decoration: false,
                background_blur: BackgroundBlurSupport::None,
            }
        );
    }
}
