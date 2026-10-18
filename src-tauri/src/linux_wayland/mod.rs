use gtk::prelude::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, AtomicU8, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Emitter, Manager, Runtime, Theme, WebviewUrl, WebviewWindowBuilder, Window,
};

pub mod app_icon;
mod background_effect;
mod decoration;

const DECORATION_PREFERENCE_FILE: &str = "linux-window-decoration";
const KWIN_DECORATION_PALETTE_FILE: &str = "kwin-decoration.colors";
const KWIN_DECORATION_PALETTE_PREFIX: &str = "kwin-decoration.";
const KWIN_DECORATION_PALETTE_SUFFIX: &str = ".colors";

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
    pub decoration_alpha: Option<u8>,
    pub csd_header: Option<CsdHeaderLayout>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsdHeaderLayout {
    pub height: i32,
    pub left: i32,
    pub right: i32,
}

fn update_csd_header<R: Runtime>(window: &Window<R>, layout: CsdHeaderLayout) {
    if let Ok(mut values) = capability_store().lock() {
        let capabilities = values.entry(window.label().to_string()).or_default();
        if capabilities.csd_header == Some(layout) {
            return;
        }
        capabilities.csd_header = Some(layout);
    }
    let _ = window.emit("linux-csd-header-layout", layout);
}

static WINDOW_CAPABILITIES: OnceLock<Mutex<HashMap<String, LinuxWindowCapabilities>>> =
    OnceLock::new();
static NATIVE_APPEARANCE: AtomicU8 = AtomicU8::new(0);
static TITLEBAR_COLORS: OnceLock<Mutex<Option<decoration::RisuTitlebarColors>>> = OnceLock::new();
// Every published theme gets its own palette file revision, because KWin only reloads a
// decoration when the palette path it was given changes.
static PALETTE_REVISION: AtomicU32 = AtomicU32::new(0);

fn native_appearance_theme() -> Option<Theme> {
    match NATIVE_APPEARANCE.load(Ordering::Relaxed) {
        1 => Some(Theme::Light),
        2 => Some(Theme::Dark),
        _ => None,
    }
}

fn capability_store() -> &'static Mutex<HashMap<String, LinuxWindowCapabilities>> {
    WINDOW_CAPABILITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn titlebar_color_store() -> &'static Mutex<Option<decoration::RisuTitlebarColors>> {
    TITLEBAR_COLORS.get_or_init(|| Mutex::new(None))
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

fn kwin_decoration_palette_file(revision: u32) -> String {
    if revision == 0 {
        KWIN_DECORATION_PALETTE_FILE.to_string()
    } else {
        format!("{KWIN_DECORATION_PALETTE_PREFIX}{revision}{KWIN_DECORATION_PALETTE_SUFFIX}")
    }
}

fn parse_palette_revision(name: &str) -> Option<u32> {
    if name == KWIN_DECORATION_PALETTE_FILE {
        return Some(0);
    }
    let revision = name
        .strip_prefix(KWIN_DECORATION_PALETTE_PREFIX)?
        .strip_suffix(KWIN_DECORATION_PALETTE_SUFFIX)?;
    revision.parse::<u32>().ok()
}

fn palette_revision() -> u32 {
    PALETTE_REVISION.load(Ordering::Relaxed)
}

fn kwin_decoration_palette_path<R: Runtime>(
    app: &AppHandle<R>,
    revision: u32,
) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(kwin_decoration_palette_file(revision)))
        .map_err(|error| error.to_string())
}

/// Old revisions are dropped, but the revision 0 file is kept: it is what a new session
/// loads before the renderer publishes the real theme, so it carries the last colors.
fn prune_kwin_decoration_palettes<R: Runtime>(app: &AppHandle<R>, current: u32) {
    let Ok(directory) = app.path().app_config_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };

    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(revision) = parse_palette_revision(&name) else {
            continue;
        };
        // The previous revision may still be the one a decoration holds.
        if revision == 0 || revision + 1 >= current {
            continue;
        }
        let _ = fs::remove_file(entry.path());
    }
}

pub fn set_linux_decoration_colors<R: Runtime>(
    app: &AppHandle<R>,
    background: &str,
    foreground: &str,
    inactive_foreground: &str,
    accent: &str,
    negative: &str,
) -> Result<Option<u8>, String> {
    if read_decoration_preference(app) != LinuxWindowDecoration::Ssd {
        clear_risu_decoration_theme();
        return Ok(None);
    }

    let titlebar_alpha = decoration::kde_titlebar_alphas();
    let palette = |path: &Path| {
        decoration::write_kwin_decoration_palette(
            path,
            background,
            foreground,
            inactive_foreground,
            accent,
            negative,
            titlebar_alpha.palette,
        )
    };

    let startup_path = kwin_decoration_palette_path(app, 0)?;
    palette(&startup_path)?;

    // KWin ignores a palette path it already stores and never re-reads it, so the theme
    // is published as a new file revision and handed to each live decoration object.
    let revision = palette_revision() + 1;
    let live_path = kwin_decoration_palette_path(app, revision)?;
    palette(&live_path)?;
    PALETTE_REVISION.store(revision, Ordering::Relaxed);

    for label in app.webview_windows().keys() {
        if !supports_native_window(label) {
            continue;
        }
        if let Err(error) = background_effect::set_decoration_palette_path(label, &live_path) {
            eprintln!(
                "[Linux Wayland] Failed to publish the decoration palette to {label}: {error}"
            );
        }
    }
    prune_kwin_decoration_palettes(app, revision);

    match decoration::RisuTitlebarColors::from_hex(background, foreground, inactive_foreground) {
        Ok(colors) => {
            if let Ok(mut stored) = titlebar_color_store().lock() {
                *stored = Some(colors);
            }
            apply_toolkit_titlebar_theme(app);
        }
        Err(error) => {
            eprintln!("[Linux Wayland] The Risu theme cannot paint the titlebar: {error}");
            decoration::clear_risu_titlebar_colors();
        }
    }

    Ok(titlebar_alpha.effective)
}

/// A compositor without the KWin decoration-palette protocol keeps GTK's own HeaderBar
/// for SSD, so the Risu theme is painted onto that HeaderBar instead of a palette file.
fn uses_toolkit_titlebar(capabilities: &LinuxWindowCapabilities) -> bool {
    !(capabilities.wayland && capabilities.server_side_decoration)
}

fn apply_toolkit_titlebar_theme<R: Runtime>(app: &AppHandle<R>) {
    let colors = match titlebar_color_store().lock() {
        Ok(stored) => *stored,
        Err(_) => return,
    };
    let Some(colors) = colors else {
        return;
    };

    for (label, window) in app.webview_windows() {
        if !supports_native_window(&label) || !uses_toolkit_titlebar(&capabilities_for(&label)) {
            continue;
        }

        match window.gtk_window() {
            Ok(gtk_window) => {
                if let Err(error) = decoration::apply_risu_titlebar_colors(&gtk_window, &colors) {
                    eprintln!(
                        "[Linux Wayland] Failed to paint the {} titlebar: {error}",
                        label
                    );
                }
            }
            Err(error) => {
                eprintln!(
                    "[Linux Wayland] {} has no GTK window to paint: {error}",
                    label
                );
            }
        }
    }
}

fn clear_risu_decoration_theme() {
    if let Ok(mut stored) = titlebar_color_store().lock() {
        *stored = None;
    }
    decoration::clear_risu_titlebar_colors();
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
        .title(crate::get_app_display_name())
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
    NATIVE_APPEARANCE.store(if dark { 2 } else { 1 }, Ordering::Relaxed);

    let mut native_window = None;
    for window in app.webview_windows().into_values() {
        window
            .set_theme(native_appearance_theme())
            .map_err(|error| error.to_string())?;
        if native_window.is_none() && supports_native_window(window.label()) {
            native_window = Some(window);
        }
    }

    if let Some(window) = native_window {
        let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
        decoration::apply_native_theme_variant(&gtk_window, dark)?;
    }
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("linux-wayland")
        .on_window_ready(|window| {
            if let Some(theme) = native_appearance_theme() {
                if let Err(error) = window.set_theme(Some(theme)) {
                    eprintln!(
                        "[Linux Wayland] Failed to apply the saved native appearance to {}: {error}",
                        window.label()
                    );
                }
                if supports_native_window(window.label()) {
                    if let Ok(gtk_window) = window.gtk_window() {
                        if let Err(error) = decoration::apply_native_theme_variant(
                            &gtk_window,
                            theme == Theme::Dark,
                        ) {
                            eprintln!(
                                "[Linux Wayland] Failed to apply the GTK theme variant to {}: {error}",
                                window.label()
                            );
                        }
                    }
                }
            }

            if !supports_native_window(window.label()) {
                return;
            }

            let requested = read_decoration_preference(window.app_handle());
            let titlebar_alpha = if requested == LinuxWindowDecoration::Ssd {
                decoration::kde_titlebar_alphas()
            } else {
                decoration::KdeTitlebarAlpha::default()
            };
            let palette_path = if requested == LinuxWindowDecoration::Ssd {
                kwin_decoration_palette_path(window.app_handle(), palette_revision())
                    .and_then(|path| {
                        let dark = native_appearance_theme() == Some(Theme::Dark);
                        decoration::ensure_kwin_decoration_palette(
                            &path,
                            dark,
                            titlebar_alpha.palette,
                        )?;
                        Ok(path)
                    })
                    .map_err(|error| {
                        eprintln!(
                            "[Linux Wayland] Failed to prepare KWin decoration palette: {error}"
                        );
                        error
                    })
                    .ok()
            } else {
                None
            };

            match background_effect::install(&window, requested, palette_path.as_deref()) {
                Ok(mut capabilities) => {
                    capabilities.decoration_alpha = if capabilities.server_side_decoration {
                        titlebar_alpha.effective
                    } else {
                        None
                    };
                    if let Ok(mut values) = capability_store().lock() {
                        capabilities.csd_header = values
                            .get(window.label())
                            .and_then(|value| value.csd_header);
                        values.insert(window.label().to_string(), capabilities.clone());
                    }
                    eprintln!(
                        "[Linux Wayland] {}: decoration={:?}, ssd={}, blur={:?}",
                        window.label(),
                        capabilities.decoration,
                        capabilities.server_side_decoration,
                        capabilities.background_blur
                    );
                    // A window created after the theme was applied still needs the
                    // current titlebar colours.
                    apply_toolkit_titlebar_theme(window.app_handle());
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
                decoration_alpha: None,
                csd_header: None,
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
    fn palette_revisions_get_their_own_file() {
        assert_eq!(
            kwin_decoration_palette_file(0),
            KWIN_DECORATION_PALETTE_FILE
        );
        assert_eq!(kwin_decoration_palette_file(3), "kwin-decoration.3.colors");
        assert_eq!(parse_palette_revision("kwin-decoration.colors"), Some(0));
        assert_eq!(parse_palette_revision("kwin-decoration.7.colors"), Some(7));
        assert_eq!(parse_palette_revision("kwin-decoration.colors.tmp"), None);
        assert_eq!(parse_palette_revision("linux-window-decoration"), None);
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
