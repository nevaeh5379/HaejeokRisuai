use tauri::{
    plugin::{Builder, TauriPlugin},
    window::{Effect, EffectState, EffectsBuilder},
    Runtime,
};

fn supports_vibrancy(label: &str) -> bool {
    label == "main" || label.starts_with("chat-window-")
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("macos-vibrancy")
        .on_window_ready(|window| {
            if !supports_vibrancy(window.label()) {
                return;
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
