use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSColor, NSTitlebarSeparatorStyle, NSWindow,
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime, Window,
};
use window_vibrancy::{
    apply_liquid_glass, apply_vibrancy, clear_liquid_glass, clear_vibrancy, LiquidGlassOptions,
    NSGlassEffectViewStyle, NSVisualEffectMaterial, NSVisualEffectState,
};

const LIQUID_GLASS_CLASS: &str = "tauri-macos-liquid-glass";
const SIDEBAR_MENU_RADIUS: f64 = 18.0;
static RISU_DARK_APPEARANCE: AtomicBool = AtomicBool::new(true);

#[derive(Default)]
struct WindowMaterials {
    native_sidebar_blur: bool,
    liquid_glass_windows: HashSet<String>,
}

#[derive(Default)]
struct MacosVibrancyState(Mutex<WindowMaterials>);

fn supports_vibrancy(label: &str) -> bool {
    label == "main" || label.starts_with("chat-window-") || label.starts_with("sidebar-menu-")
}

fn is_sidebar_menu(label: &str) -> bool {
    label.starts_with("sidebar-menu-")
}

fn sync_liquid_glass_dom_state<R: Runtime>(window: &Window<R>, active: bool) {
    let Some(webview) = window.app_handle().get_webview_window(window.label()) else {
        return;
    };
    let action = if active { "add" } else { "remove" };
    let script = format!("document.documentElement?.classList.{action}('{LIQUID_GLASS_CLASS}')");
    if let Err(error) = webview.eval(script) {
        eprintln!(
            "[macOS vibrancy] Failed to sync immediate Liquid Glass DOM state for {}: {error}",
            window.label()
        );
    }
}

fn apply_risu_appearance(ns_window: &NSWindow, dark: bool) {
    // SAFETY: AppKit exports these process-lifetime appearance-name constants.
    let appearance_name = unsafe {
        if dark {
            NSAppearanceNameDarkAqua
        } else {
            NSAppearanceNameAqua
        }
    };
    if let Some(appearance) = NSAppearance::appearanceNamed(appearance_name) {
        ns_window.setAppearance(Some(&appearance));
        if let Some(content) = ns_window.contentView() {
            content.setAppearance(Some(&appearance));
            for subview in content.subviews() {
                subview.setAppearance(Some(&appearance));
            }
        }
    }
}

fn apply_native_vibrancy<R: Runtime>(window: &Window<R>) -> Result<(), Box<dyn std::error::Error>> {
    let popup = is_sidebar_menu(window.label());
    let material = if popup {
        NSVisualEffectMaterial::Popover
    } else {
        NSVisualEffectMaterial::Sidebar
    };
    let radius = popup.then_some(SIDEBAR_MENU_RADIUS);
    apply_vibrancy(
        window,
        material,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        radius,
    )?;
    Ok(())
}

fn apply_window_material<R: Runtime>(
    window: &Window<R>,
    state: &mut WindowMaterials,
) -> Result<(), Box<dyn std::error::Error>> {
    // Both APIs insert their own view. Remove the previous material before
    // switching so repeated toggles cannot stack glass and vibrancy layers.
    clear_liquid_glass(window)?;
    clear_vibrancy(window)?;
    state.liquid_glass_windows.remove(window.label());
    sync_liquid_glass_dom_state(window, false);

    let liquid_glass_active = if state.native_sidebar_blur {
        apply_native_vibrancy(window)?;
        eprintln!(
            "[macOS vibrancy] Applied native sidebar blur to {}",
            window.label()
        );
        false
    } else {
        let mut options = LiquidGlassOptions::new(NSGlassEffectViewStyle::Regular).opaque(false);
        if is_sidebar_menu(window.label()) {
            options = options.radius(SIDEBAR_MENU_RADIUS);
        }
        match apply_liquid_glass(window, options) {
            Ok(()) => {
                eprintln!(
                    "[macOS vibrancy] Applied Liquid Glass to {}",
                    window.label()
                );
                true
            }
            Err(error) => {
                // Preserve the existing compatibility path on older macOS.
                eprintln!("[macOS vibrancy] Liquid Glass unavailable for {}; using native vibrancy: {error}", window.label());
                apply_native_vibrancy(window)?;
                false
            }
        }
    };
    if liquid_glass_active {
        state.liquid_glass_windows.insert(window.label().to_owned());
    }
    sync_liquid_glass_dom_state(window, liquid_glass_active);
    let native: &NSWindow = unsafe { &*window.ns_window()?.cast() };
    apply_risu_appearance(native, RISU_DARK_APPEARANCE.load(Ordering::Relaxed));
    if is_sidebar_menu(window.label()) {
        clip_sidebar_menu_window(window)?;
    }
    Ok(())
}

pub async fn set_native_sidebar_blur<R: Runtime>(
    app: &tauri::AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    let app_for_main = app.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let materials = app_for_main.state::<MacosVibrancyState>();
            let mut state = materials.0.lock().map_err(|error| error.to_string())?;
            if state.native_sidebar_blur == enabled {
                return Ok(());
            }
            state.native_sidebar_blur = enabled;
            for window in app_for_main.webview_windows().into_values() {
                if supports_vibrancy(window.label()) {
                    apply_window_material(&window.as_ref().window(), &mut state)
                        .map_err(|error| format!("{}: {error}", window.label()))?;
                }
            }
            Ok(())
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

fn clip_sidebar_menu_window<R: Runtime>(
    window: &Window<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    // SAFETY: The window-ready callback runs on the main thread, and Tauri
    // returns the native NSWindow pointer on macOS.
    let native: &NSWindow = unsafe { &*window.ns_window()?.cast() };
    let content = native.contentView().ok_or("missing popup content view")?;
    content.setWantsLayer(true);
    let layer = content.layer().ok_or("missing popup content layer")?;
    // Clip the whole popup, including its native glass/vibrancy background
    // and WebView, rather than rounding only the glass view underneath.
    layer.setCornerRadius(SIDEBAR_MENU_RADIUS);
    layer.setMasksToBounds(true);
    native.invalidateShadow();
    Ok(())
}

pub fn set_risu_native_appearance<R: Runtime>(
    app: &tauri::AppHandle<R>,
    dark: bool,
) -> tauri::Result<()> {
    RISU_DARK_APPEARANCE.store(dark, Ordering::Relaxed);

    for window in app.webview_windows().into_values() {
        if !supports_vibrancy(window.label()) {
            continue;
        }

        let label = window.label().to_string();
        let window_for_main_thread = window.clone();
        window.run_on_main_thread(move || match window_for_main_thread.ns_window() {
            Ok(ns_window) => {
                // SAFETY: Tauri's `ns_window` is an NSWindow pointer on macOS.
                let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
                apply_risu_appearance(ns_window, dark);
                eprintln!(
                    "[macOS vibrancy] Synced Risu {} appearance to {}",
                    if dark { "dark" } else { "light" },
                    label
                );
            }
            Err(error) => {
                eprintln!("[macOS vibrancy] Failed to sync Risu appearance to {label}: {error}")
            }
        })?;
    }

    Ok(())
}

fn configure_native_window<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    let ns_window = window.ns_window()?;
    // SAFETY: Tauri's `ns_window` is an NSWindow pointer on macOS and this
    // callback is invoked on the window/main thread.
    let ns_window: &NSWindow = unsafe { &*ns_window.cast() };

    apply_risu_appearance(ns_window, RISU_DARK_APPEARANCE.load(Ordering::Relaxed));
    ns_window.setTitlebarAppearsTransparent(true);
    ns_window.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
    ns_window.setOpaque(false);
    let clear = NSColor::clearColor();
    ns_window.setBackgroundColor(Some(&clear));
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("macos-vibrancy")
        .setup(|app, _| {
            app.manage(MacosVibrancyState::default());
            Ok(())
        })
        .on_window_ready(|window| {
            if !supports_vibrancy(window.label()) {
                return;
            }

            if let Err(error) = configure_native_window(&window) {
                eprintln!(
                    "[macOS vibrancy] Failed to configure native window {}: {error}",
                    window.label()
                );
            }

            let materials = window.app_handle().state::<MacosVibrancyState>();
            let result = materials
                .0
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|mut state| {
                    apply_window_material(&window, &mut state).map_err(|error| error.to_string())
                });
            if let Err(error) = result {
                eprintln!(
                    "[macOS vibrancy] Failed to apply material to {}: {error}",
                    window.label()
                );
            }
        })
        .on_page_load(|webview, _| {
            let materials = webview.app_handle().state::<MacosVibrancyState>();
            let liquid_glass_active = materials
                .0
                .lock()
                .map(|state| state.liquid_glass_windows.contains(webview.label()))
                .unwrap_or(false);
            let action = if liquid_glass_active { "add" } else { "remove" };
            let script =
                format!("document.documentElement.classList.{action}('{LIQUID_GLASS_CLASS}')");
            if let Err(error) = webview.eval(script) {
                eprintln!(
                    "[macOS vibrancy] Failed to sync Liquid Glass DOM state for {}: {error}",
                    webview.label()
                );
            }
        })
        .on_event(|app, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = event
            {
                if let Ok(mut state) = app.state::<MacosVibrancyState>().0.lock() {
                    state.liquid_glass_windows.remove(label);
                }
            }
        })
        .build()
}
