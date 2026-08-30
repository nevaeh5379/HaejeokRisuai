use crate::app::router::AppRouter;
use crate::components::bootstrap::BootstrapGate;
use crate::state::app_state::AppState;
use leptos::prelude::*;
use leptos_meta::{provide_meta_context, Title};
use leptos_router::components::Router;

#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();
    let state = AppState::new();
    provide_context(state);

    view! {
        <Title text="RisuAI (Leptos Rust)" />
        <BootstrapGate>
            {move || view! {
                <Router>
                    <AppRouter />
                </Router>
            }}
        </BootstrapGate>
    }
}
