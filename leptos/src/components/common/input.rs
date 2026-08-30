use crate::components::common::button::{ActionCallback, StringCallback};
use crate::components::common::icon::{Icon, IconName};
use leptos::prelude::*;

#[component]
pub fn Input(
    #[prop(optional)] label: Option<&'static str>,
    #[prop(optional)] placeholder: Option<&'static str>,
    #[prop(default = "text")] input_type: &'static str,
    #[prop(optional)] value: Option<Signal<String>>,
    #[prop(into, optional)] on_change: Option<StringCallback>,
    #[prop(optional)] class: &'static str,
    #[prop(optional)] id: Option<&'static str>,
    #[prop(optional)] autocomplete: Option<&'static str>,
    #[prop(default = false)] disabled: bool,
    #[prop(into, optional)] on_enter: Option<ActionCallback>,
) -> impl IntoView {
    let val_str = move || value.map(|v| v.get()).unwrap_or_default();

    view! {
        <div class="input-group">
            {if let Some(lbl) = label {
                view! { <label class="input-label" for=id.unwrap_or("")>{lbl}</label> }.into_any()
            } else {
                ().into_any()
            }}
            <input
                id=id.unwrap_or("")
                type=input_type
                class=format!("input-control {}", class)
                placeholder=placeholder.unwrap_or("")
                autocomplete=autocomplete.unwrap_or("off")
                disabled=disabled
                prop:value=val_str
                on:input=move |ev| {
                    if let Some(cb) = &on_change {
                        cb.run(event_target_value(&ev));
                    }
                }
                on:keydown=move |ev: web_sys::KeyboardEvent| {
                    if ev.key() == "Enter" {
                        if let Some(cb) = &on_enter {
                            cb.run();
                        }
                    }
                }
            />
        </div>
    }
}

#[component]
pub fn ObscuredInput(
    #[prop(optional)] label: Option<&'static str>,
    #[prop(optional)] placeholder: Option<&'static str>,
    #[prop(optional)] value: Option<Signal<String>>,
    #[prop(into, optional)] on_change: Option<StringCallback>,
    #[prop(default = true)] default_obscured: bool,
    #[prop(optional)] class: &'static str,
    #[prop(optional)] id: Option<&'static str>,
    #[prop(optional)] autocomplete: Option<&'static str>,
    #[prop(default = false)] disabled: bool,
    #[prop(into, optional)] on_enter: Option<ActionCallback>,
) -> impl IntoView {
    let is_obscured = RwSignal::new(default_obscured);
    let val_str = move || value.map(|v| v.get()).unwrap_or_default();

    view! {
        <div class="input-group">
            {if let Some(lbl) = label {
                view! { <label class="input-label" for=id.unwrap_or("")>{lbl}</label> }.into_any()
            } else {
                ().into_any()
            }}
            <div style="position: relative; display: flex; align-items: center; width: 100%;">
                <input
                    id=id.unwrap_or("")
                    type=move || if is_obscured.get() { "password" } else { "text" }
                    class=format!("input-control {}", class)
                    style="padding-right: 2.5rem; width: 100%;"
                    placeholder=placeholder.unwrap_or("")
                    autocomplete=autocomplete.unwrap_or("off")
                    disabled=disabled
                    prop:value=val_str
                    on:input=move |ev| {
                        if let Some(cb) = &on_change {
                            cb.run(event_target_value(&ev));
                        }
                    }
                    on:keydown=move |ev: web_sys::KeyboardEvent| {
                        if ev.key() == "Enter" {
                            if let Some(cb) = &on_enter {
                                cb.run();
                            }
                        }
                    }
                />
                <button
                    type="button"
                    class="btn-icon"
                    style="position: absolute; right: 0.5rem; padding: 0.25rem; color: var(--risu-theme-textcolor2); border: none; background: none; display: flex; align-items: center; justify-content: center;"
                    aria-label=move || if is_obscured.get() { "Show secret" } else { "Hide secret" }
                    on:click=move |_| is_obscured.update(|v| *v = !*v)
                >
                    {move || if is_obscured.get() {
                        view! { <Icon name=IconName::Eye size=16 /> }.into_any()
                    } else {
                        view! { <Icon name=IconName::EyeOff size=16 /> }.into_any()
                    }}
                </button>
            </div>
        </div>
    }
}

#[component]
pub fn Textarea(
    #[prop(optional)] label: Option<&'static str>,
    #[prop(optional)] placeholder: Option<&'static str>,
    #[prop(optional)] value: Option<Signal<String>>,
    #[prop(into, optional)] on_change: Option<StringCallback>,
    #[prop(optional)] class: &'static str,
    #[prop(default = false)] disabled: bool,
) -> impl IntoView {
    let val_str = move || value.map(|v| v.get()).unwrap_or_default();

    view! {
        <div class="input-group">
            {if let Some(lbl) = label {
                view! { <label class="input-label">{lbl}</label> }.into_any()
            } else {
                ().into_any()
            }}
            <textarea
                class=format!("input-control {}", class)
                placeholder=placeholder.unwrap_or("")
                disabled=disabled
                prop:value=val_str
                on:input=move |ev| {
                    if let Some(cb) = &on_change {
                        cb.run(event_target_value(&ev));
                    }
                }
            ></textarea>
        </div>
    }
}
