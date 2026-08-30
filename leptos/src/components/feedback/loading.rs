use leptos::prelude::*;

#[component]
pub fn LoadingSpinner(
    #[prop(default = "Loading...")] text: &'static str,
    #[prop(optional)] class: &'static str,
) -> impl IntoView {
    view! {
        <div class=format!("loading-container {}", class)>
            <div class="spinner"></div>
            <span>{text}</span>
        </div>
    }
}

#[component]
pub fn AirisuLoading(
    #[prop(default = "Airisu is preparing your data...")] text: &'static str,
) -> impl IntoView {
    view! {
        <div class="loading-container">
            <div class="airisu-avatar">
                "🌸"
            </div>
            <div style="font-weight: 700; font-size: 1.1rem; color: var(--risu-theme-textcolor);">
                "RisuAI"
            </div>
            <span style="font-size: 0.875rem; color: var(--risu-theme-textcolor2);">{text}</span>
        </div>
    }
}

#[component]
pub fn SkeletonCard() -> impl IntoView {
    view! {
        <div class="card" style="opacity: 0.6; pointer-events: none;">
            <div style="height: 1.25rem; width: 60%; background-color: var(--risu-theme-selected); border-radius: var(--risu-radius-sm); margin-bottom: 0.75rem;"></div>
            <div style="height: 0.875rem; width: 90%; background-color: var(--risu-theme-selected); border-radius: var(--risu-radius-sm); margin-bottom: 0.5rem;"></div>
            <div style="height: 0.875rem; width: 40%; background-color: var(--risu-theme-selected); border-radius: var(--risu-radius-sm);"></div>
        </div>
    }
}
