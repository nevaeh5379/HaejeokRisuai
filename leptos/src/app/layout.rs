use crate::components::layout::header::Header;
use crate::components::layout::mobile_nav::MobileNav;
use crate::components::layout::sidebar::Sidebar;
use leptos::prelude::*;

#[component]
pub fn AppLayout(children: Children) -> impl IntoView {
    view! {
        <div class="app-container">
            // Desktop Sidebar
            <Sidebar />

            // Main View Area
            <div class="app-main-content">
                <Header />
                <main class="app-page-viewport">
                    {children()}
                </main>
                <MobileNav />
            </div>
        </div>
    }
}
