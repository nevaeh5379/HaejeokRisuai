use crate::components::feedback::loading::LoadingSpinner;
use leptos::prelude::*;

#[component]
pub fn CheckingScreen() -> impl IntoView {
    view! {
        <div class="bootstrap-wrapper" style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; background-color: var(--risu-theme-bgcolor);">
            <div class="card" style="max-width: 28rem; width: 100%; text-align: center; padding: 2rem;">
                <div style="font-size: 2.5rem; margin-bottom: 1rem;">"🌸"</div>
                <h1 style="font-size: 1.5rem; font-weight: 800; color: var(--risu-primary); margin-bottom: 0.5rem;">
                    "RisuAI"
                </h1>
                <p style="color: var(--risu-theme-textcolor2); font-size: 0.875rem; margin-bottom: 1.5rem;">
                    "Next-Gen Rust & Leptos WebAssembly Client"
                </p>
                <LoadingSpinner text="Verifying backend health & credentials..." />
            </div>
        </div>
    }
}
