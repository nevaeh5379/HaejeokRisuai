use crate::components::common::badge::Badge;
use crate::components::common::button::{Button, ButtonVariant};
use crate::components::common::card::Card;
use crate::components::common::icon::{Icon, IconName};
use crate::components::feedback::empty::EmptyState;
use crate::components::feedback::error::ApiErrorView;
use crate::components::feedback::loading::LoadingSpinner;
use crate::models::character::CharacterDetail;
use crate::state::app_state::AppState;
use leptos::prelude::*;
use leptos_router::components::A;
use leptos_router::hooks::use_params_map;

#[component]
pub fn CharacterDetailPage() -> impl IntoView {
    let state = expect_context::<AppState>();
    let params = use_params_map();

    let character_id = Memo::new(move |_| {
        let p = params.get();
        p.get("id")
            .filter(|id| !id.trim().is_empty())
            .map(|id| id.trim().to_string())
    });

    let character_resource = LocalResource::new(move || {
        let id_opt = character_id.get();
        let api = state.api.get();
        async move {
            match id_opt {
                Some(id) => api.get_character(&id).await.map(Some),
                None => Ok(None),
            }
        }
    });

    view! {
        <div style="max-width: 56rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem;">
            // Navigation Bar / Breadcrumb
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem;">
                <A href="/characters">
                    <Button variant=ButtonVariant::Ghost>
                        <Icon name=IconName::ChevronLeft size=18 />
                        <span>"Back to Characters"</span>
                    </Button>
                </A>
            </div>

            // Main Content Area
            <Suspense fallback=move || view! {
                <Card>
                    <LoadingSpinner text="Loading character details..." />
                </Card>
            }>
                {move || {
                    let id_val = character_id.get();
                    if id_val.is_none() {
                        return view! {
                            <Card>
                                <EmptyState
                                    icon="❓"
                                    title="Invalid Character ID"
                                    description="No valid character identifier was provided in the route parameters."
                                />
                            </Card>
                        }.into_any();
                    }
                    let route_id = id_val.unwrap();

                    match character_resource.get() {
                        None => view! {
                            <Card>
                                <LoadingSpinner text="Loading character details..." />
                            </Card>
                        }.into_any(),
                        Some(res) => {
                            match (*res).clone() {
                                Ok(Some(detail)) => {
                                    view_character_detail(route_id, detail).into_any()
                                }
                                Ok(None) => {
                                    view! {
                                        <Card>
                                            <EmptyState
                                                icon="❓"
                                                title="Character Not Found"
                                                description="The requested character could not be found."
                                            />
                                        </Card>
                                    }.into_any()
                                }
                                Err(err) => {
                                    view! {
                                        <ApiErrorView
                                            error=err
                                            on_retry=move || {
                                                character_resource.refetch();
                                            }
                                        />
                                    }.into_any()
                                }
                            }
                        }
                    }
                }}
            </Suspense>
        </div>
    }
}

fn view_character_detail(route_id: String, detail: CharacterDetail) -> impl IntoView {
    let name = if detail.name.trim().is_empty() {
        "Unnamed Character".to_string()
    } else {
        detail.name.clone()
    };

    let has_creator = detail
        .creator
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_version = detail
        .character_version
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_tags = !detail.tags.is_empty();

    let has_desc = detail
        .desc
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_personality = detail
        .personality
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_scenario = detail
        .scenario
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_first_message = detail
        .first_message
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_example_message = detail
        .example_message
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_system_prompt = detail
        .system_prompt
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_creator_notes = detail
        .creator_notes
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let has_notes = detail
        .notes
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    view! {
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
            // Header Card: Avatar Placeholder, Name, Route ID & Badges
            <Card>
                <div style="display: flex; flex-direction: row; gap: 1.25rem; align-items: center; flex-wrap: wrap;">
                    // Neutral Avatar Placeholder
                    <div style="width: 4.5rem; height: 4.5rem; border-radius: var(--risu-radius-md); background-color: var(--risu-theme-selected); border: 1px solid var(--risu-theme-darkborderc); display: flex; align-items: center; justify-content: center; font-size: 2rem; flex-shrink: 0;">
                        "🎭"
                    </div>

                    // Character Metadata Overview
                    <div style="flex: 1; min-width: 12rem; display: flex; flex-direction: column; gap: 0.375rem;">
                        <h1 style="font-size: 1.5rem; font-weight: 800; line-height: 1.2; word-break: break-word;">
                            {name}
                        </h1>
                        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                            <span style="font-size: 0.8125rem; color: var(--risu-theme-textcolor2); font-family: monospace; background: var(--risu-theme-darkbg); padding: 0.125rem 0.5rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-theme-darkborderc);">
                                {format!("ID: {}", route_id)}
                            </span>
                            {if has_version {
                                let ver = detail.character_version.unwrap();
                                view! {
                                    <Badge>
                                        {format!("v{}", ver)}
                                    </Badge>
                                }.into_any()
                            } else {
                                ().into_any()
                            }}
                            {if has_creator {
                                let cr = detail.creator.unwrap();
                                view! {
                                    <span style="font-size: 0.8125rem; color: var(--risu-theme-textcolor2);">
                                        {format!("by {}", cr)}
                                    </span>
                                }.into_any()
                            } else {
                                ().into_any()
                            }}
                        </div>
                    </div>
                </div>

                // Tags Section
                {if has_tags {
                    view! {
                        <div style="display: flex; flex-wrap: wrap; gap: 0.375rem; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--risu-theme-darkborderc);">
                            {detail.tags.into_iter().map(|tag| {
                                view! {
                                    <Badge>
                                        {tag}
                                    </Badge>
                                }
                            }).collect_view()}
                        </div>
                    }.into_any()
                } else {
                    ().into_any()
                }}
            </Card>

            // Description Section
            {if has_desc {
                let desc_text = detail.desc.unwrap();
                view! {
                    <Card>
                        <h3 style="font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--risu-theme-textcolor);">
                            "Description"
                        </h3>
                        <div style="white-space: pre-wrap; line-height: 1.6; font-size: 0.9375rem; color: var(--risu-theme-textcolor2);">
                            {desc_text}
                        </div>
                    </Card>
                }.into_any()
            } else {
                ().into_any()
            }}

            // Personality Section
            {if has_personality {
                let personality_text = detail.personality.unwrap();
                view! {
                    <Card>
                        <h3 style="font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--risu-theme-textcolor);">
                            "Personality"
                        </h3>
                        <div style="white-space: pre-wrap; line-height: 1.6; font-size: 0.9375rem; color: var(--risu-theme-textcolor2);">
                            {personality_text}
                        </div>
                    </Card>
                }.into_any()
            } else {
                ().into_any()
            }}

            // Scenario Section
            {if has_scenario {
                let scenario_text = detail.scenario.unwrap();
                view! {
                    <Card>
                        <h3 style="font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--risu-theme-textcolor);">
                            "Scenario"
                        </h3>
                        <div style="white-space: pre-wrap; line-height: 1.6; font-size: 0.9375rem; color: var(--risu-theme-textcolor2);">
                            {scenario_text}
                        </div>
                    </Card>
                }.into_any()
            } else {
                ().into_any()
            }}

            // First Message Section
            {if has_first_message {
                let first_msg_text = detail.first_message.unwrap();
                view! {
                    <Card>
                        <h3 style="font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--risu-theme-textcolor);">
                            "First Message"
                        </h3>
                        <div style="white-space: pre-wrap; line-height: 1.6; font-size: 0.9375rem; background: var(--risu-theme-darkbg); padding: 0.875rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-theme-darkborderc);">
                            {first_msg_text}
                        </div>
                    </Card>
                }.into_any()
            } else {
                ().into_any()
            }}

            // Example Message Section
            {if has_example_message {
                let example_msg_text = detail.example_message.unwrap();
                view! {
                    <Card>
                        <h3 style="font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--risu-theme-textcolor);">
                            "Example Messages"
                        </h3>
                        <div style="white-space: pre-wrap; line-height: 1.6; font-size: 0.875rem; font-family: monospace; background: var(--risu-theme-darkbg); padding: 0.875rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-theme-darkborderc);">
                            {example_msg_text}
                        </div>
                    </Card>
                }.into_any()
            } else {
                ().into_any()
            }}

            // System Prompt Section
            {if has_system_prompt {
                let sys_prompt_text = detail.system_prompt.unwrap();
                view! {
                    <Card>
                        <h3 style="font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--risu-theme-textcolor);">
                            "System Prompt"
                        </h3>
                        <div style="white-space: pre-wrap; line-height: 1.6; font-size: 0.875rem; font-family: monospace; background: var(--risu-theme-darkbg); padding: 0.875rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-theme-darkborderc);">
                            {sys_prompt_text}
                        </div>
                    </Card>
                }.into_any()
            } else {
                ().into_any()
            }}

            // Creator Notes Section
            {if has_creator_notes {
                let creator_notes_text = detail.creator_notes.unwrap();
                view! {
                    <Card>
                        <h3 style="font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--risu-theme-textcolor);">
                            "Creator Notes"
                        </h3>
                        <div style="white-space: pre-wrap; line-height: 1.6; font-size: 0.9375rem; color: var(--risu-theme-textcolor2);">
                            {creator_notes_text}
                        </div>
                    </Card>
                }.into_any()
            } else {
                ().into_any()
            }}

            // General Notes Section
            {if has_notes {
                let notes_text = detail.notes.unwrap();
                view! {
                    <Card>
                        <h3 style="font-size: 1rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--risu-theme-textcolor);">
                            "Notes"
                        </h3>
                        <div style="white-space: pre-wrap; line-height: 1.6; font-size: 0.9375rem; color: var(--risu-theme-textcolor2);">
                            {notes_text}
                        </div>
                    </Card>
                }.into_any()
            } else {
                ().into_any()
            }}
        </div>
    }
}
