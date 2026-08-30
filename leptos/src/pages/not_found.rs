use crate::components::common::button::{Button, ButtonVariant};
use crate::components::common::icon::{Icon, IconName};
use crate::components::feedback::empty::EmptyState;
use leptos::prelude::*;
use leptos_router::components::A;

#[component]
pub fn NotFoundPage() -> impl IntoView {
    view! {
        <div style="max-width: 36rem; margin: 4rem auto; text-align: center;">
            <EmptyState
                icon="🧭"
                title="404 - Page Not Found"
                description="The page you are looking for does not exist or has been moved."
            />
            <div style="margin-top: 1rem;">
                <A href="/">
                    <Button variant=ButtonVariant::Primary>
                        <Icon name=IconName::ChevronLeft size=16 />
                        <span>"Return to Dashboard"</span>
                    </Button>
                </A>
            </div>
        </div>
    }
}
