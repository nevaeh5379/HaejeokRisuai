use crate::components::common::icon::{Icon, IconName};
use leptos::prelude::*;

#[component]
pub fn MobileNav() -> impl IntoView {
    view! {
        <nav class="mobile-bottom-nav">
            <a href="/" class="mobile-nav-item">
                <Icon name=IconName::Chat size=20 />
                <span>"Home"</span>
            </a>
            <a href="/chat" class="mobile-nav-item">
                <Icon name=IconName::Send size=20 />
                <span>"Chat"</span>
            </a>
            <a href="/characters" class="mobile-nav-item">
                <Icon name=IconName::Users size=20 />
                <span>"Chars"</span>
            </a>
            <a href="/library" class="mobile-nav-item">
                <Icon name=IconName::BookOpen size=20 />
                <span>"Library"</span>
            </a>
            <a href="/settings" class="mobile-nav-item">
                <Icon name=IconName::Settings size=20 />
                <span>"Settings"</span>
            </a>
        </nav>
    }
}
