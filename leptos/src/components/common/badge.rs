use leptos::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BadgeVariant {
    #[default]
    Neutral,
    Success,
    Warning,
    Danger,
}

impl BadgeVariant {
    pub fn class(&self) -> &'static str {
        match self {
            BadgeVariant::Neutral => "badge badge-neutral",
            BadgeVariant::Success => "badge badge-success",
            BadgeVariant::Warning => "badge badge-warning",
            BadgeVariant::Danger => "badge badge-danger",
        }
    }
}

#[component]
pub fn Badge(
    #[prop(default = BadgeVariant::Neutral)] variant: BadgeVariant,
    #[prop(default = false)] with_dot: bool,
    #[prop(optional)] class: &'static str,
    children: Children,
) -> impl IntoView {
    let base_class = variant.class();
    let combined_class = if class.is_empty() {
        base_class.to_string()
    } else {
        format!("{} {}", base_class, class)
    };

    view! {
        <span class=combined_class>
            {if with_dot {
                view! { <span class="badge-dot"></span> }.into_any()
            } else {
                ().into_any()
            }}
            {children()}
        </span>
    }
}
