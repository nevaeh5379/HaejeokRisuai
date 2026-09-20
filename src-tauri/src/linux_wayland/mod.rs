use gtk::prelude::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

mod background_effect;
mod decoration;

const DECORATION_PREFERENCE_FILE: &str = "linux-window-decoration";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundBlurSupport {
    Standard,
    KwinLegacy,
    #[default]
    None,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinuxWindowDecoration {
    #[default]
    Ssd,
    Csd,
}

impl LinuxWindowDecoration {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ssd => "ssd",
            Self::Csd => "csd",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxWindowCapabilities {
    pub wayland: bool,
    pub server_side_decoration: bool,
    pub background_blur: BackgroundBlurSupport,
    pub decoration: LinuxWindowDecoration,
}

static WINDOW_CAPABILITIES: OnceLock<Mutex<HashMap<String, LinuxWindowCapabilities>>> =
    OnceLock::new();

fn capability_store() -> &'static Mutex<HashMap<String, LinuxWindowCapabilities>> {
    WINDOW_CAPABILITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn capabilities_for(label: &str) -> LinuxWindowCapabilities {
    capability_store()
        .lock()
        .ok()
        .and_then(|values| values.get(label).cloned())
        .unwrap_or_default()
}

fn supports_native_window(label: &str) -> bool {
    label == "main" || label.starts_with("chat-window-")
}

fn parse_decoration(value: &str) -> Result<LinuxWindowDecoration, String> {
    match value.trim() {
        "ssd" => Ok(LinuxWindowDecoration::Ssd),
        "csd" => Ok(LinuxWindowDecoration::Csd),
        _ => Err(format!("Unsupported Linux window decoration mode: {value}")),
    }
}

fn preference_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(DECORATION_PREFERENCE_FILE))
        .map_err(|error| error.to_string())
}

fn read_preference_file(path: &Path) -> LinuxWindowDecoration {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| parse_decoration(&value).ok())
        .unwrap_or_default()
}

fn write_preference_file(path: &Path, decoration: LinuxWindowDecoration) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Linux window decoration preference has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let temporary = path.with_extension("tmp");
    fs::write(&temporary, decoration.as_str()).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn read_decoration_preference<R: Runtime>(app: &AppHandle<R>) -> LinuxWindowDecoration {
    preference_path(app)
        .map(|path| read_preference_file(&path))
        .unwrap_or_default()
}

pub fn set_decoration_preference<R: Runtime>(
    app: &AppHandle<R>,
    decoration: &str,
) -> Result<(), String> {
    let decoration = parse_decoration(decoration)?;
    let path = preference_path(app)?;
    write_preference_file(&path, decoration)
}

pub fn create_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }

    let requested = read_decoration_preference(app);

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Risuai")
        .inner_size(1024.0, 768.0)
        .min_inner_size(300.0, 500.0)
        .resizable(true)
        .disable_drag_drop_handler()
        // Tao creates its native GtkHeaderBar on Wayland even for an
        // undecorated window. Bootstrap CSD as undecorated so GTK never asks
        // KWin for SSD before the plugin moves that HeaderBar into an overlay.
        .decorations(decoration::bootstrap_decorations_enabled(requested))
        .transparent(true)
        .visible(false)
        .build()?;

    eprintln!(
        "[Linux Wayland] Created main window with {:?} GTK decoration bootstrap",
        requested
    );
    Ok(())
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
        decoration::set_native_appearance_class(&gtk_window, dark);
    }
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("linux-wayland")
        .on_window_ready(|window| {
            if !supports_native_window(window.label()) {
                return;
            }

            let requested = read_decoration_preference(window.app_handle());
            match background_effect::install(&window, requested) {
                Ok(capabilities) => {
                    if let Ok(mut values) = capability_store().lock() {
                        values.insert(window.label().to_string(), capabilities.clone());
                    }
                    eprintln!(
                        "[Linux Wayland] {}: decoration={:?}, ssd={}, blur={:?}",
                        window.label(),
                        capabilities.decoration,
                        capabilities.server_side_decoration,
                        capabilities.background_blur
                    );
                }
                Err(error) => {
                    if let Ok(gtk_window) = window.gtk_window() {
                        gtk_window.show_all();
                    }
                    eprintln!(
                        "[Linux Wayland] Failed to initialize {}; showing fallback window: {error}",
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
    fn default_capabilities_use_ssd_without_claiming_wayland_support() {
        assert_eq!(
            LinuxWindowCapabilities::default(),
            LinuxWindowCapabilities {
                wayland: false,
                server_side_decoration: false,
                background_blur: BackgroundBlurSupport::None,
                decoration: LinuxWindowDecoration::Ssd,
            }
        );
    }

    #[test]
    fn decoration_parser_accepts_supported_modes() {
        assert_eq!(parse_decoration("ssd").unwrap(), LinuxWindowDecoration::Ssd);
        assert_eq!(parse_decoration("csd").unwrap(), LinuxWindowDecoration::Csd);
        assert!(parse_decoration("auto").is_err());
    }

    #[test]
    fn preference_file_round_trips() {
        let path = std::env::temp_dir().join(format!(
            "risu-linux-window-decoration-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        assert_eq!(read_preference_file(&path), LinuxWindowDecoration::Ssd);
        write_preference_file(&path, LinuxWindowDecoration::Csd).unwrap();
        assert_eq!(read_preference_file(&path), LinuxWindowDecoration::Csd);

        let _ = std::fs::remove_file(path);
    }
}
