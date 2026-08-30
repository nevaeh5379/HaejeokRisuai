use crate::app::layout::AppLayout;
use crate::pages::{CharactersPage, ChatPage, HealthPage, HomePage, NotFoundPage, SettingsPage};
use leptos::prelude::*;
use leptos_router::components::*;
use leptos_router::path;

#[component]
pub fn AppRouter() -> impl IntoView {
    view! {
        <AppLayout>
            <Routes fallback=NotFoundPage>
                <Route path=path!("/") view=HomePage />
                <Route path=path!("/chat") view=ChatPage />
                <Route path=path!("/characters") view=CharactersPage />
                <Route path=path!("/health") view=HealthPage />
                <Route path=path!("/settings") view=SettingsPage />
            </Routes>
        </AppLayout>
    }
}
