use leptos::prelude::*;
use std::sync::Arc;

#[derive(Clone)]
pub struct MouseCallback(Arc<dyn Fn(web_sys::MouseEvent) + Send + Sync>);

impl<F: Fn(web_sys::MouseEvent) + Send + Sync + 'static> From<F> for MouseCallback {
    fn from(f: F) -> Self {
        Self(Arc::new(f))
    }
}

impl MouseCallback {
    pub fn run(&self, ev: web_sys::MouseEvent) {
        (self.0)(ev);
    }
}

#[derive(Clone)]
pub struct ActionCallback(Arc<dyn Fn() + Send + Sync>);

impl<F: Fn() + Send + Sync + 'static> From<F> for ActionCallback {
    fn from(f: F) -> Self {
        Self(Arc::new(f))
    }
}

impl ActionCallback {
    pub fn run(&self) {
        (self.0)();
    }
}

#[derive(Clone)]
pub struct StringCallback(Arc<dyn Fn(String) + Send + Sync>);

impl<F: Fn(String) + Send + Sync + 'static> From<F> for StringCallback {
    fn from(f: F) -> Self {
        Self(Arc::new(f))
    }
}

impl StringCallback {
    pub fn run(&self, val: String) {
        (self.0)(val);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ButtonVariant {
    #[default]
    Primary,
    Secondary,
    Danger,
    Ghost,
}

impl ButtonVariant {
    pub fn class(&self) -> &'static str {
        match self {
            ButtonVariant::Primary => "btn btn-primary",
            ButtonVariant::Secondary => "btn btn-secondary",
            ButtonVariant::Danger => "btn btn-danger",
            ButtonVariant::Ghost => "btn btn-ghost",
        }
    }
}

#[component]
pub fn Button(
    #[prop(default = ButtonVariant::Primary)] variant: ButtonVariant,
    #[prop(default = false)] disabled: bool,
    #[prop(default = false)] loading: bool,
    #[prop(optional)] class: &'static str,
    #[prop(into, optional)] on_click: Option<MouseCallback>,
    children: Children,
) -> impl IntoView {
    let base_class = variant.class();
    let combined_class = if class.is_empty() {
        base_class.to_string()
    } else {
        format!("{} {}", base_class, class)
    };

    let is_disabled = disabled || loading;

    view! {
        <button
            class=combined_class
            disabled=is_disabled
            on:click=move |ev| {
                if !is_disabled {
                    if let Some(cb) = &on_click {
                        cb.run(ev);
                    }
                }
            }
        >
            {if loading {
                view! { <span class="spinner" style="width: 1rem; height: 1rem; border-width: 2px;"></span> }.into_any()
            } else {
                ().into_any()
            }}
            {children()}
        </button>
    }
}
