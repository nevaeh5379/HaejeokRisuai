pub mod lorebooks;
pub mod personas;

use self::lorebooks::LorebooksTab;
use self::personas::PersonasTab;
use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::card::Card;
use crate::components::common::icon::{Icon, IconName};
use leptos::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LibraryTab {
    #[default]
    Personas,
    Lorebooks,
    Modules,
    Presets,
}

impl LibraryTab {
    pub fn label(&self) -> &'static str {
        match self {
            LibraryTab::Personas => "Personas",
            LibraryTab::Lorebooks => "Lorebooks",
            LibraryTab::Modules => "Modules",
            LibraryTab::Presets => "Presets",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            LibraryTab::Personas => "Browse stored user personas and identity cards.",
            LibraryTab::Lorebooks => "Inspect world info encyclopedias and lorebook entries.",
            LibraryTab::Modules => "Inspect custom UI scripts and extension modules.",
            LibraryTab::Presets => "Inspect generation parameters and system prompt presets.",
        }
    }
}

#[component]
pub fn LibraryPage() -> impl IntoView {
    let active_tab = RwSignal::new(LibraryTab::Personas);

    let tabs = [
        LibraryTab::Personas,
        LibraryTab::Lorebooks,
        LibraryTab::Modules,
        LibraryTab::Presets,
    ];

    view! {
        <div style="max-width: 56rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem;">
            // Page Header
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;">
                <div>
                    <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.25rem;">
                        <h1 style="font-size: 1.5rem; font-weight: 800; display: flex; align-items: center; gap: 0.5rem;">
                            <Icon name=IconName::BookOpen size=24 class="text-primary" />
                            <span>"Library"</span>
                        </h1>
                        <Badge variant=BadgeVariant::Neutral>
                            "Read-only"
                        </Badge>
                    </div>
                    <p style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">
                        "Browse stored personas, lorebooks, modules, and presets from local database."
                    </p>
                </div>
            </div>

            // Tab Navigation Buttons
            <div style="display: flex; gap: 0.5rem; border-bottom: 1px solid var(--risu-theme-darkborderc); padding-bottom: 0.5rem; overflow-x: auto;">
                {tabs.into_iter().map(|tab| {
                    let is_active = move || active_tab.get() == tab;
                    view! {
                        <button
                            class=move || if is_active() {
                                "btn btn-secondary active"
                            } else {
                                "btn btn-ghost"
                            }
                            style=move || if is_active() {
                                "border-color: var(--risu-primary); background-color: var(--risu-theme-selected);"
                            } else {
                                ""
                            }
                            on:click=move |_| active_tab.set(tab)
                        >
                            <span>{tab.label()}</span>
                        </button>
                    }
                }).collect_view()}
            </div>

            // Tab Content Branch (strictly only selected branch is instantiated/rendered)
            {move || {
                let current = active_tab.get();
                match current {
                    LibraryTab::Personas => view! {
                        <PersonasTab />
                    }.into_any(),
                    LibraryTab::Lorebooks => view! {
                        <LorebooksTab />
                    }.into_any(),
                    LibraryTab::Modules => view! {
                        <Card>
                            <div style="padding: 1.5rem; text-align: center; color: var(--risu-theme-textcolor2);">
                                <h3 style="font-size: 1.125rem; font-weight: 600; color: var(--risu-theme-textcolor); margin-bottom: 0.5rem;">
                                    {current.label()}
                                </h3>
                                <p style="font-size: 0.875rem;">
                                    {current.description()}
                                </p>
                            </div>
                        </Card>
                    }.into_any(),
                    LibraryTab::Presets => view! {
                        <Card>
                            <div style="padding: 1.5rem; text-align: center; color: var(--risu-theme-textcolor2);">
                                <h3 style="font-size: 1.125rem; font-weight: 600; color: var(--risu-theme-textcolor); margin-bottom: 0.5rem;">
                                    {current.label()}
                                </h3>
                                <p style="font-size: 0.875rem;">
                                    {current.description()}
                                </p>
                            </div>
                        </Card>
                    }.into_any(),
                }
            }}
        </div>
    }
}
