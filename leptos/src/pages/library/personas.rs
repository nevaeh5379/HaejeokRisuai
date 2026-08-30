use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::button::{Button, ButtonVariant};
use crate::components::common::card::Card;
use crate::components::feedback::empty::EmptyState;
use crate::components::feedback::error::ApiErrorView;
use crate::components::feedback::loading::LoadingSpinner;
use crate::state::app_state::AppState;
use crate::utils::text::truncate_chars;
use leptos::prelude::*;

#[component]
pub fn PersonasTab() -> impl IntoView {
    let state = expect_context::<AppState>();
    let expanded_idx = RwSignal::new(Option::<usize>::None);

    let personas_resource = LocalResource::new(move || {
        let api = state.api.get_untracked();
        async move { api.get_personas().await }
    });

    view! {
        <Suspense fallback=move || view! {
            <Card>
                <LoadingSpinner text="Loading personas..." />
            </Card>
        }>
            {move || {
                personas_resource.get().map(|res| {
                    match (*res).clone() {
                        Ok(envelope) if envelope.personas.is_empty() => {
                            view! {
                                <Card>
                                    <EmptyState
                                        icon="👤"
                                        title="No Personas Found"
                                        description="There are no persona cards stored in the database."
                                    />
                                </Card>
                            }.into_any()
                        }
                        Ok(envelope) => {
                            let personas = envelope.personas;
                            view! {
                                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                                    {personas.into_iter().enumerate().map(|(idx, persona)| {
                                        let is_expanded = move || expanded_idx.get() == Some(idx);
                                        let on_toggle = move |_| {
                                            expanded_idx.update(|cur| {
                                                *cur = if *cur == Some(idx) { None } else { Some(idx) };
                                            });
                                        };

                                        let name = if persona.name.trim().is_empty() {
                                            "Unnamed Persona".to_string()
                                        } else {
                                            persona.name.clone()
                                        };

                                        let note = persona.note.clone().filter(|n| !n.trim().is_empty());
                                        let icon_path = persona.icon.clone();
                                        let icon_display = if icon_path.trim().is_empty() {
                                            "None".to_string()
                                        } else {
                                            truncate_chars(icon_path.trim(), 40)
                                        };
                                        let is_large_portrait = persona.large_portrait.unwrap_or(false);
                                        let prompt = persona.persona_prompt.clone();
                                        let has_prompt = !prompt.trim().is_empty();
                                        let truncated_prompt = truncate_chars(prompt.trim(), 1000);

                                        view! {
                                            <div class="card" style="padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
                                                <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
                                                    <div style="display: flex; align-items: center; gap: 0.75rem; min-width: 0;">
                                                        <div style="font-weight: 700; font-size: 1rem; color: var(--risu-theme-textcolor); word-break: break-word;">
                                                            {name}
                                                        </div>
                                                        {if is_large_portrait {
                                                            view! {
                                                                <Badge variant=BadgeVariant::Neutral>
                                                                    "Large Portrait"
                                                                </Badge>
                                                            }.into_any()
                                                        } else {
                                                            ().into_any()
                                                        }}
                                                    </div>
                                                    <Button
                                                        variant=ButtonVariant::Ghost
                                                        on_click=on_toggle
                                                    >
                                                        <span>{move || if is_expanded() { "Hide Details" } else { "Inspect" }}</span>
                                                    </Button>
                                                </div>

                                                <div style="font-size: 0.8125rem; color: var(--risu-theme-textcolor2); display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem;">
                                                    <div>
                                                        <span style="font-weight: 600; color: var(--risu-theme-textcolor);">"Icon: "</span>
                                                        <span style="font-family: monospace;">{icon_display}</span>
                                                    </div>
                                                    {if let Some(ref n) = note {
                                                        let note_preview = truncate_chars(n.trim(), 60);
                                                        view! {
                                                            <div>
                                                                <span style="font-weight: 600; color: var(--risu-theme-textcolor);">"Note: "</span>
                                                                <span>{note_preview}</span>
                                                            </div>
                                                        }.into_any()
                                                    } else {
                                                        ().into_any()
                                                    }}
                                                </div>

                                                {move || if is_expanded() {
                                                    let exp_note = note.clone();
                                                    let exp_prompt = truncated_prompt.clone();

                                                    view! {
                                                        <div style="margin-top: 0.5rem; padding-top: 0.75rem; border-top: 1px solid var(--risu-theme-darkborderc); display: flex; flex-direction: column; gap: 0.75rem;">
                                                            {if let Some(n) = exp_note {
                                                                view! {
                                                                    <div>
                                                                        <div style="font-size: 0.75rem; font-weight: 700; color: var(--risu-theme-textcolor2); text-transform: uppercase; margin-bottom: 0.25rem;">
                                                                            "Note"
                                                                        </div>
                                                                        <div style="font-size: 0.875rem; color: var(--risu-theme-textcolor); white-space: pre-wrap; background-color: var(--risu-theme-bgcolor); padding: 0.625rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-theme-darkborderc);">
                                                                            {n}
                                                                        </div>
                                                                    </div>
                                                                }.into_any()
                                                            } else {
                                                                ().into_any()
                                                            }}

                                                            <div>
                                                                <div style="font-size: 0.75rem; font-weight: 700; color: var(--risu-theme-textcolor2); text-transform: uppercase; margin-bottom: 0.25rem;">
                                                                    "Persona Prompt"
                                                                </div>
                                                                {if has_prompt {
                                                                    view! {
                                                                        <div style="font-size: 0.875rem; color: var(--risu-theme-textcolor); white-space: pre-wrap; background-color: var(--risu-theme-bgcolor); padding: 0.625rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-theme-darkborderc); font-family: inherit;">
                                                                            {exp_prompt}
                                                                        </div>
                                                                    }.into_any()
                                                                } else {
                                                                    view! {
                                                                        <div style="font-size: 0.875rem; color: var(--risu-theme-textcolor2); font-style: italic;">
                                                                            "No persona prompt defined."
                                                                        </div>
                                                                    }.into_any()
                                                                }}
                                                            </div>
                                                        </div>
                                                    }.into_any()
                                                } else {
                                                    ().into_any()
                                                }}
                                            </div>
                                        }
                                    }).collect_view()}
                                </div>
                            }.into_any()
                        }
                        Err(err) => {
                            view! {
                                <ApiErrorView
                                    error=err
                                    on_retry=move || {
                                        personas_resource.refetch();
                                    }
                                />
                            }.into_any()
                        }
                    }
                })
            }}
        </Suspense>
    }
}
