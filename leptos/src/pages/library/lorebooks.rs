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
pub fn LorebooksTab() -> impl IntoView {
    let state = expect_context::<AppState>();
    let expanded_group_idx = RwSignal::new(Option::<usize>::None);

    let lorebooks_resource = LocalResource::new(move || {
        let api = state.api.get_untracked();
        async move { api.get_lorebooks().await }
    });

    view! {
        <Suspense fallback=move || view! {
            <Card>
                <LoadingSpinner text="Loading lorebooks..." />
            </Card>
        }>
            {move || {
                lorebooks_resource.get().map(|res| {
                    match (*res).clone() {
                        Ok(envelope) if envelope.lore_book.is_empty() => {
                            view! {
                                <Card>
                                    <EmptyState
                                        icon="📖"
                                        title="No Lorebooks Found"
                                        description="There are no lorebook groups stored in the database."
                                    />
                                </Card>
                            }.into_any()
                        }
                        Ok(envelope) => {
                            let groups = envelope.lore_book;
                            view! {
                                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                                    {groups.into_iter().enumerate().map(|(g_idx, group)| {
                                        let is_group_expanded = move || expanded_group_idx.get() == Some(g_idx);
                                        let on_toggle_group = move |_| {
                                            expanded_group_idx.update(|cur| {
                                                *cur = if *cur == Some(g_idx) { None } else { Some(g_idx) };
                                            });
                                        };

                                        let group_name = if group.name.trim().is_empty() {
                                            "Unnamed Lorebook Group".to_string()
                                        } else {
                                            group.name.clone()
                                        };

                                        let entry_count = group.data.len();
                                        let entries = group.data;

                                        view! {
                                            <div class="card" style="padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
                                                <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
                                                    <div style="display: flex; align-items: center; gap: 0.75rem; min-width: 0;">
                                                        <div style="font-weight: 700; font-size: 1rem; color: var(--risu-theme-textcolor); word-break: break-word;">
                                                            {group_name}
                                                        </div>
                                                        <Badge variant=BadgeVariant::Neutral>
                                                            {format!("{} {}", entry_count, if entry_count == 1 { "entry" } else { "entries" })}
                                                        </Badge>
                                                    </div>
                                                    <Button
                                                        variant=ButtonVariant::Ghost
                                                        on_click=on_toggle_group
                                                    >
                                                        <span>{move || if is_group_expanded() { "Hide Entries" } else { "Inspect" }}</span>
                                                    </Button>
                                                </div>

                                                {move || if is_group_expanded() {
                                                    let group_entries = entries.clone();

                                                    view! {
                                                        <div style="margin-top: 0.5rem; padding-top: 0.75rem; border-top: 1px solid var(--risu-theme-darkborderc); display: flex; flex-direction: column; gap: 0.75rem;">
                                                            {if group_entries.is_empty() {
                                                                view! {
                                                                    <div style="font-size: 0.875rem; color: var(--risu-theme-textcolor2); font-style: italic; padding: 0.5rem 0;">
                                                                        "No entries in this lorebook group."
                                                                    </div>
                                                                }.into_any()
                                                            } else {
                                                                view! {
                                                                    <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                                                                        {group_entries.into_iter().map(|entry| {
                                                                            let key_display = if entry.key.trim().is_empty() {
                                                                                if entry.secondkey.trim().is_empty() {
                                                                                    "No activation key".to_string()
                                                                                } else {
                                                                                    format!("2nd: {}", entry.secondkey.trim())
                                                                                }
                                                                            } else if entry.secondkey.trim().is_empty() {
                                                                                entry.key.trim().to_string()
                                                                            } else {
                                                                                format!("{}, 2nd: {}", entry.key.trim(), entry.secondkey.trim())
                                                                            };

                                                                            let comment = entry.comment.trim().to_string();
                                                                            let has_comment = !comment.is_empty();
                                                                            let mode = if entry.mode.trim().is_empty() {
                                                                                "normal".to_string()
                                                                            } else {
                                                                                entry.mode.trim().to_string()
                                                                            };

                                                                            let is_regex = entry.use_regex.unwrap_or(false);
                                                                            let content_preview = truncate_chars(entry.content.trim(), 160);
                                                                            let has_content = !entry.content.trim().is_empty();

                                                                            view! {
                                                                                <div style="background-color: var(--risu-theme-bgcolor); border: 1px solid var(--risu-theme-darkborderc); border-radius: var(--risu-radius-md); padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;">
                                                                                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap;">
                                                                                        <div style="font-weight: 600; font-size: 0.875rem; color: var(--risu-theme-textcolor); word-break: break-word;">
                                                                                            <span style="color: var(--risu-primary); font-family: monospace; margin-right: 0.375rem;">"#"</span>
                                                                                            {key_display}
                                                                                        </div>
                                                                                        <div style="display: flex; align-items: center; gap: 0.375rem; flex-wrap: wrap;">
                                                                                            <Badge variant=BadgeVariant::Neutral>
                                                                                                {format!("mode: {}", mode)}
                                                                                            </Badge>
                                                                                            {if entry.always_active {
                                                                                                view! {
                                                                                                    <Badge variant=BadgeVariant::Warning>
                                                                                                        "Always Active"
                                                                                                    </Badge>
                                                                                                }.into_any()
                                                                                            } else {
                                                                                                ().into_any()
                                                                                            }}
                                                                                            {if entry.selective {
                                                                                                view! {
                                                                                                    <Badge variant=BadgeVariant::Neutral>
                                                                                                        "Selective"
                                                                                                    </Badge>
                                                                                                }.into_any()
                                                                                            } else {
                                                                                                ().into_any()
                                                                                            }}
                                                                                            {if is_regex {
                                                                                                view! {
                                                                                                    <Badge variant=BadgeVariant::Neutral>
                                                                                                        "Regex"
                                                                                                    </Badge>
                                                                                                }.into_any()
                                                                                            } else {
                                                                                                ().into_any()
                                                                                            }}
                                                                                        </div>
                                                                                    </div>

                                                                                    {if has_comment {
                                                                                        view! {
                                                                                            <div style="font-size: 0.8125rem; color: var(--risu-theme-textcolor2);">
                                                                                                <span style="font-weight: 600;">"Comment: "</span>
                                                                                                <span>{comment}</span>
                                                                                            </div>
                                                                                        }.into_any()
                                                                                    } else {
                                                                                        ().into_any()
                                                                                    }}

                                                                                    <div style="font-size: 0.8125rem; color: var(--risu-theme-textcolor); background-color: var(--risu-theme-darkbg); padding: 0.5rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-theme-darkborderc); font-family: inherit; white-space: pre-wrap; word-break: break-word;">
                                                                                        {if has_content {
                                                                                            content_preview
                                                                                        } else {
                                                                                            "(Empty entry content)".to_string()
                                                                                        }}
                                                                                    </div>
                                                                                </div>
                                                                            }
                                                                        }).collect_view()}
                                                                    </div>
                                                                }.into_any()
                                                            }}
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
                                        lorebooks_resource.refetch();
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
