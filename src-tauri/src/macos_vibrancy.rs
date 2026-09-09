use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSColor, NSTitlebarSeparatorStyle, NSWindow,
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    window::{Effect, EffectState, EffectsBuilder},
    Manager, Runtime, Window,
};
use window_vibrancy::{apply_liquid_glass, LiquidGlassOptions, NSGlassEffectViewStyle};

const LIQUID_GLASS_CLASS: &str = "tauri-macos-liquid-glass";
static RISU_DARK_APPEARANCE: AtomicBool = AtomicBool::new(true);

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
    }
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
    let liquid_glass_windows = Arc::new(Mutex::new(HashSet::<String>::new()));
    let ready_windows = Arc::clone(&liquid_glass_windows);
    let page_windows = Arc::clone(&liquid_glass_windows);

    Builder::new("macos-vibrancy")
        .on_window_ready(move |window| {
            if !supports_vibrancy(window.label()) {
                return;
            }

            if let Err(error) = configure_native_window(&window) {
                eprintln!(
                    "[macOS vibrancy] Failed to configure native window {}: {error}",
                    window.label()
                );
            }

            let mut liquid_glass =
                LiquidGlassOptions::new(NSGlassEffectViewStyle::Regular).opaque(false);
            if is_sidebar_menu(window.label()) {
                liquid_glass = liquid_glass.radius(18.0);
            }

            match apply_liquid_glass(&window, liquid_glass) {
                Ok(()) => {
                    if let Ok(mut windows) = ready_windows.lock() {
                        windows.insert(window.label().to_string());
                    }
                    sync_liquid_glass_dom_state(&window, true);
                    eprintln!(
                        "[macOS vibrancy] Applied Liquid Glass to {}",
                        window.label()
                    );
                }
                Err(liquid_glass_error) => {
                    if let Ok(mut windows) = ready_windows.lock() {
                        windows.remove(window.label());
                    }
                    sync_liquid_glass_dom_state(&window, false);
                    eprintln!(
                        "[macOS vibrancy] Liquid Glass unavailable for {}; using fallback vibrancy: {liquid_glass_error}",
                        window.label()
                    );
                    let fallback_effect = if is_sidebar_menu(window.label()) {
                        Effect::Popover
                    } else {
                        Effect::Sidebar
                    };
                    let effects = EffectsBuilder::new()
                        .effect(fallback_effect)
                        .state(EffectState::FollowsWindowActiveState)
                        .build();
                    if let Err(vibrancy_error) = window.set_effects(effects) {
                        eprintln!(
                            "[macOS vibrancy] Liquid Glass unavailable for {} ({liquid_glass_error}); fallback vibrancy also failed: {vibrancy_error}",
                            window.label()
                        );
                    }
                }
            }
        })
        .on_page_load(move |webview, _| {
            let liquid_glass_active = page_windows
                .lock()
                .map(|windows| windows.contains(webview.label()))
                .unwrap_or(false);
            let action = if liquid_glass_active { "add" } else { "remove" };
            let script = format!(
                "document.documentElement.classList.{action}('{LIQUID_GLASS_CLASS}')"
            );
            if let Err(error) = webview.eval(script) {
                eprintln!(
                    "[macOS vibrancy] Failed to sync Liquid Glass DOM state for {}: {error}",
                    webview.label()
                );
            }
        })
        .build()
}
