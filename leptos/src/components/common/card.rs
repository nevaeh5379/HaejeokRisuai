use leptos::prelude::*;

#[component]
pub fn CardHeader(
    #[prop(optional)] title: Option<&'static str>,
    #[prop(optional)] class: &'static str,
    #[prop(optional)] children: Option<Children>,
) -> impl IntoView {
    view! {
        <div class=format!("card-header {}", class)>
            {if let Some(t) = title {
                view! { <h3 class="card-title">{t}</h3> }.into_any()
            } else {
                ().into_any()
            }}
            {if let Some(ch) = children {
                ch().into_any()
            } else {
                ().into_any()
            }}
        </div>
    }
}

#[component]
pub fn Card(#[prop(optional)] class: &'static str, children: Children) -> impl IntoView {
    view! {
        <div class=format!("card {}", class)>
            {children()}
        </div>
    }
}
