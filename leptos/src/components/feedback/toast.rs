use crate::state::app_state::AppState;
use crate::state::ui_state::ToastType;
use leptos::prelude::*;

#[component]
pub fn ToastContainer() -> impl IntoView {
    let state = expect_context::<AppState>();
    let toasts = state.ui.toasts;

    view! {
        <div class="toast-container">
            <For
                each=move || toasts.get()
                key=|t| t.id
                children=move |t| {
                    let id = t.id;
                    let (bg_border, icon_char) = match t.toast_type {
                        ToastType::Success => ("border-color: rgba(80, 250, 123, 0.4);", "✓"),
                        ToastType::Warning => ("border-color: rgba(255, 184, 108, 0.4);", "⚠"),
                        ToastType::Error => ("border-color: rgba(255, 85, 85, 0.4);", "✕"),
                        ToastType::Info => ("border-color: var(--risu-theme-borderc);", "ℹ"),
                    };

                    view! {
                        <div class="toast" style=bg_border>
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <span style="font-weight: 700;">{icon_char}</span>
                                <span>{t.message}</span>
                            </div>
                            <button
                                style="opacity: 0.6; padding: 0.25rem;"
                                on:click=move |_| state.ui.dismiss_toast(id)
                            >
                                "✕"
                            </button>
                        </div>
                    }
                }
            />
        </div>
    }
}
