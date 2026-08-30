use crate::components::common::button::{ActionCallback, Button, ButtonVariant};
use crate::components::common::icon::{Icon, IconName};
use leptos::prelude::*;

#[component]
pub fn Modal(
    #[prop(default = false)] open: bool,
    title: &'static str,
    #[prop(into)] on_close: ActionCallback,
    children: Children,
) -> impl IntoView {
    if !open {
        return ().into_any();
    }

    let on_close_click = on_close.clone();

    view! {
        <div class="modal-overlay" on:click=move |_| on_close.run()>
            <div class="modal-content" on:click=move |ev| ev.stop_propagation()>
                <div class="card-header" style="margin-bottom: 0; padding: 1.25rem;">
                    <h3 class="card-title">{title}</h3>
                    <Button
                        variant=ButtonVariant::Ghost
                        class="btn-icon"
                        on_click=move |_| on_close_click.run()
                    >
                        <Icon name=IconName::Close size=18 />
                    </Button>
                </div>
                <div style="padding: 1.25rem;">
                    {children()}
                </div>
            </div>
        </div>
    }
    .into_any()
}
