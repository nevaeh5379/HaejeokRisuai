use objc2_app_kit::{NSColor, NSTitlebarSeparatorStyle, NSWindow};
use tauri::{
    plugin::{Builder, TauriPlugin},
    window::{Effect, EffectState, EffectsBuilder},
    Runtime, Window,
};

fn supports_vibrancy(label: &str) -> bool {
    label == "main" || label.starts_with("chat-window-")
}

fn configure_native_window<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    let ns_window = window.ns_window()?;
    // SAFETY: Tauri's `ns_window` is an NSWindow pointer on macOS and this
    // callback is invoked on the window/main thread.
    let ns_window: &NSWindow = unsafe { &*ns_window.cast() };

    ns_window.setTitlebarAppearsTransparent(true);
    ns_window.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
    ns_window.setOpaque(false);
    let clear = NSColor::clearColor();
    ns_window.setBackgroundColor(Some(&clear));
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("macos-vibrancy")
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

            let effects = EffectsBuilder::new()
                .effect(Effect::Sidebar)
                .state(EffectState::FollowsWindowActiveState)
                .build();
            if let Err(error) = window.set_effects(effects) {
                eprintln!(
                    "[macOS vibrancy] Failed to apply material to {}: {error}",
                    window.label()
                );
            }
        })
        .build()
}
