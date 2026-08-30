use crate::components::common::button::{Button, ButtonVariant};
use crate::components::common::card::Card;
use crate::components::common::icon::{Icon, IconName};
use crate::components::feedback::empty::EmptyState;
use crate::components::feedback::error::ErrorBanner;
use crate::components::feedback::loading::LoadingSpinner;
use crate::state::app_state::AppState;
use leptos::prelude::*;
use leptos_router::hooks::use_navigate;

#[component]
pub fn CharactersPage() -> impl IntoView {
    let state = expect_context::<AppState>();
    let navigate = use_navigate();
    let input_query = RwSignal::new(String::new());
    let active_query = RwSignal::new(String::new());

    // Fetches characters using explicit submit/query signal (initial empty query fetches the first 50)
    let characters_resource = LocalResource::new(move || {
        let query = active_query.get();
        let api = state.api.get();
        async move { api.search_characters(&query).await }
    });

    let on_search_submit = move || {
        let q = input_query.get().trim().to_string();
        active_query.set(q);
    };

    let on_search_clear = move || {
        input_query.set(String::new());
        active_query.set(String::new());
    };

    view! {
        <div style="max-width: 56rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem;">
            // Search & Action Header
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;">
                <div>
                    <h1 style="font-size: 1.5rem; font-weight: 800; display: flex; align-items: center; gap: 0.5rem;">
                        <Icon name=IconName::Users size=24 class="text-primary" />
                        <span>"Character Catalog"</span>
                    </h1>
                    <p style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">
                        "Search characters from database (backend returns up to 50 results)"
                    </p>
                </div>
                <div style="display: flex; gap: 0.75rem;">
                    <Button
                        variant=ButtonVariant::Secondary
                        disabled=true
                    >
                        <Icon name=IconName::Plus size=16 />
                        <span>"Import Card (Disabled)"</span>
                    </Button>
                </div>
            </div>

            // Search Bar with explicit submit control (optimized for low-RAM/mobile keystroke control)
            <div style="display: flex; gap: 0.5rem; align-items: center;">
                <div style="position: relative; flex: 1;">
                    <input
                        type="text"
                        class="input-control"
                        placeholder="Search characters by name... (Press Enter or click Search)"
                        style="padding-left: 2.5rem;"
                        prop:value=move || input_query.get()
                        on:input=move |ev| {
                            input_query.set(event_target_value(&ev));
                        }
                        on:keydown=move |ev: web_sys::KeyboardEvent| {
                            if ev.key() == "Enter" {
                                ev.prevent_default();
                                on_search_submit();
                            }
                        }
                    />
                    <div style="position: absolute; left: 0.875rem; top: 50%; transform: translateY(-50%); opacity: 0.5; pointer-events: none;">
                        <Icon name=IconName::Search size=18 />
                    </div>
                </div>
                <Button
                    variant=ButtonVariant::Primary
                    on_click=move |_| on_search_submit()
                >
                    <Icon name=IconName::Search size=16 />
                    <span>"Search"</span>
                </Button>
                {move || {
                    if !input_query.get().is_empty() || !active_query.get().is_empty() {
                        view! {
                            <Button
                                variant=ButtonVariant::Ghost
                                on_click=move |_| on_search_clear()
                            >
                                <span>"Clear"</span>
                            </Button>
                        }.into_any()
                    } else {
                        ().into_any()
                    }
                }}
            </div>

            // Characters Grid
            <Suspense fallback=move || view! {
                <Card>
                    <LoadingSpinner text="Loading characters from backend..." />
                </Card>
            }>
                {move || {
                    characters_resource.get().map(|res| {
                        match (*res).clone() {
                            Ok(chars) if chars.is_empty() => {
                                view! {
                                    <Card>
                                        <EmptyState
                                            icon="👥"
                                            title="No Characters Found"
                                            description="No characters match your search query, or the database contains no character entries yet."
                                        />
                                    </Card>
                                }.into_any()
                            }
                            Ok(chars) => {
                                let chars_list = chars.clone();
                                view! {
                                    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem;">
                                        {chars_list.into_iter().map(|char_data| {
                                            let id = char_data.id.clone();
                                            let name = char_data.name.clone();
                                            let id_for_click = id.clone();
                                            let navigate = navigate.clone();

                                            view! {
                                                <div class="card" style="display: flex; flex-direction: column; justify-content: space-between; gap: 1rem;">
                                                    <div>
                                                        <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
                                                            <div style="width: 2.75rem; height: 2.75rem; border-radius: var(--risu-radius-full); background-color: var(--risu-theme-selected); display: flex; align-items: center; justify-content: center; font-size: 1.25rem;">
                                                                "🎭"
                                                            </div>
                                                            <div style="overflow: hidden;">
                                                                <h3 style="font-size: 1rem; font-weight: 700; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                                                                    {name}
                                                                </h3>
                                                                <span style="font-size: 0.75rem; color: var(--risu-theme-textcolor2); font-family: monospace;">
                                                                    {id.clone()}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <Button
                                                        variant=ButtonVariant::Primary
                                                        on_click=move |_| {
                                                            let encoded_id = urlencoding::encode(&id_for_click);
                                                            navigate(&format!("/characters/{}", encoded_id), Default::default());
                                                        }
                                                    >
                                                        <Icon name=IconName::Eye size=16 />
                                                        <span>"View Details"</span>
                                                    </Button>
                                                </div>
                                            }
                                        }).collect_view()}
                                    </div>
                                }.into_any()
                            }
                            Err(err) => {
                                view! {
                                    <Card>
                                        <ErrorBanner message=format!("Failed to load characters: {}", err) />
                                    </Card>
                                }.into_any()
                            }
                        }
                    })
                }}
            </Suspense>
        </div>
    }
}
