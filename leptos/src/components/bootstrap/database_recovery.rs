use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::button::{ActionCallback, Button, ButtonVariant};
use crate::components::common::card::{Card, CardHeader};
use crate::components::common::icon::{Icon, IconName};
use crate::components::common::input::ObscuredInput;
use crate::components::feedback::loading::LoadingSpinner;
use crate::models::db_config::{
    DatabaseConfigResponse, TestDatabasePayload, UpdateDatabaseConfigPayload,
};
use crate::state::app_state::AppState;
use crate::state::ui_state::ToastType;
use leptos::prelude::*;

#[component]
pub fn DatabaseRecoveryScreen(
    #[prop(into)] on_storage_ready: ActionCallback,
) -> impl IntoView {
    let state = expect_context::<AppState>();

    let current_config = RwSignal::new(Option::<DatabaseConfigResponse>::None);
    let is_loading_config = RwSignal::new(true);

    let enable_postgres = RwSignal::new(true);
    let connection_string_input = RwSignal::new(String::new());
    let backup_connection_string_input = RwSignal::new(String::new());

    let test_latency = RwSignal::new(Option::<u64>::None);
    let test_error = RwSignal::new(Option::<String>::None);
    let is_testing = RwSignal::new(false);

    let is_saving = RwSignal::new(false);
    let is_retrying = RwSignal::new(false);
    let general_error = RwSignal::new(Option::<String>::None);

    // Fetch existing masked configuration
    let fetch_config = {
        let state = state;
        move || {
            is_loading_config.set(true);
            let api = state.api.get_untracked();
            leptos::task::spawn_local(async move {
                match api.get_db_config().await {
                    Ok(cfg) => {
                        enable_postgres.set(cfg.enabled);
                        current_config.set(Some(cfg));
                        is_loading_config.set(false);
                    }
                    Err(err) => {
                        general_error.set(Some(format!("Failed to fetch DB config: {}", err)));
                        is_loading_config.set(false);
                    }
                }
            });
        }
    };

    // Initial load of config
    fetch_config();

    // Test connection action
    let handle_test = {
        let state = state;
        move || {
            let conn = connection_string_input.get().trim().to_string();
            if conn.is_empty() {
                test_error.set(Some("Please enter a connection string to test".to_string()));
                test_latency.set(None);
                return;
            }

            is_testing.set(true);
            test_error.set(None);
            test_latency.set(None);

            let api = state.api.get_untracked();
            leptos::task::spawn_local(async move {
                let payload = TestDatabasePayload {
                    connection_string: conn,
                };
                match api.test_db_config(&payload).await {
                    Ok(resp) => {
                        is_testing.set(false);
                        if resp.success {
                            test_latency.set(resp.latency_ms.or(Some(0)));
                            test_error.set(None);
                        } else {
                            test_error.set(Some(resp.error.unwrap_or_else(|| "Unknown database error".to_string())));
                            test_latency.set(None);
                        }
                    }
                    Err(err) => {
                        is_testing.set(false);
                        test_error.set(Some(err.to_string()));
                        test_latency.set(None);
                    }
                }
            });
        }
    };

    // Save and apply action
    let handle_save = {
        let on_storage_ready = on_storage_ready.clone();
        let fetch_config = fetch_config.clone();
        let state = state;
        move || {
            let conn = connection_string_input.get().trim().to_string();
            let backup = backup_connection_string_input.get().trim().to_string();
            let enabled = enable_postgres.get();

            if enabled && conn.is_empty() {
                general_error.set(Some(
                    "Please enter a valid PostgreSQL connection string before saving. Note that masked passwords cannot be reused as-is.".to_string(),
                ));
                return;
            }

            is_saving.set(true);
            general_error.set(None);

            let api = state.api.get_untracked();
            let on_storage_ready = on_storage_ready.clone();
            let fetch_config = fetch_config.clone();

            leptos::task::spawn_local(async move {
                let payload = UpdateDatabaseConfigPayload {
                    enabled,
                    connection_string: conn,
                    backup_connection_string: if backup.is_empty() {
                        None
                    } else {
                        Some(backup)
                    },
                };

                match api.update_db_config(&payload).await {
                    Ok(resp) => {
                        if resp.success {
                            // Check health to verify if storage is now ready
                            match api.get_health().await {
                                Ok(health) if health.is_ready() => {
                                    is_saving.set(false);
                                    state
                                        .ui
                                        .toast("Database connected successfully!", ToastType::Success);
                                    on_storage_ready.run();
                                }
                                Ok(health) => {
                                    is_saving.set(false);
                                    general_error.set(Some(format!(
                                        "Config saved, but storage status is still '{}'. Please verify database credentials.",
                                        health.storage.status
                                    )));
                                    fetch_config();
                                }
                                Err(err) => {
                                    is_saving.set(false);
                                    general_error.set(Some(format!("Config saved, but health check failed: {}", err)));
                                    fetch_config();
                                }
                            }
                        } else {
                            is_saving.set(false);
                            general_error.set(Some(
                                resp.error.unwrap_or_else(|| "Failed to update configuration".to_string()),
                            ));
                        }
                    }
                    Err(err) => {
                        is_saving.set(false);
                        general_error.set(Some(format!("Save request failed: {}", err)));
                    }
                }
            });
        }
    };

    // Retry existing configuration
    let handle_retry = {
        let on_storage_ready = on_storage_ready.clone();
        let fetch_config = fetch_config.clone();
        let state = state;
        move || {
            is_retrying.set(true);
            general_error.set(None);

            let api = state.api.get_untracked();
            let on_storage_ready = on_storage_ready.clone();
            let fetch_config = fetch_config.clone();

            leptos::task::spawn_local(async move {
                match api.retry_db_config().await {
                    Ok(resp) => {
                        if resp.success {
                            match api.get_health().await {
                                Ok(health) if health.is_ready() => {
                                    is_retrying.set(false);
                                    state
                                        .ui
                                        .toast("Database connection restored!", ToastType::Success);
                                    on_storage_ready.run();
                                }
                                Ok(health) => {
                                    is_retrying.set(false);
                                    general_error.set(Some(format!(
                                        "Retry succeeded, but storage is still '{}'.",
                                        health.storage.status
                                    )));
                                    fetch_config();
                                }
                                Err(err) => {
                                    is_retrying.set(false);
                                    general_error.set(Some(format!("Health check failed: {}", err)));
                                    fetch_config();
                                }
                            }
                        } else {
                            is_retrying.set(false);
                            general_error.set(Some(
                                resp.error.unwrap_or_else(|| "Failed to reconnect to database".to_string()),
                            ));
                        }
                    }
                    Err(err) => {
                        is_retrying.set(false);
                        general_error.set(Some(format!("Retry failed: {}", err)));
                    }
                }
            });
        }
    };

    view! {
        <div class="bootstrap-wrapper" style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; background-color: var(--risu-theme-bgcolor);">
            <div class="card" style="max-width: 42rem; width: 100%; padding: 2rem; display: flex; flex-direction: column; gap: 1.5rem;">
                // Header
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; border-bottom: 1px solid var(--risu-theme-darkborderc); padding-bottom: 1.25rem;">
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <div style="color: var(--risu-warning); display: flex;">
                            <Icon name=IconName::Database size=28 />
                        </div>
                        <div>
                            <h1 style="font-size: 1.25rem; font-weight: 800;">
                                "Database Storage Recovery"
                            </h1>
                            <p style="font-size: 0.8125rem; color: var(--risu-theme-textcolor2);">
                                "Configure or restore PostgreSQL database connection"
                            </p>
                        </div>
                    </div>
                    <Badge variant=BadgeVariant::Warning with_dot=true>
                        "Storage Unconfigured"
                    </Badge>
                </div>

                // General Error Banner
                {move || general_error.get().map(|msg| view! {
                    <div
                        role="alert"
                        style="background-color: rgba(255, 85, 85, 0.15); border: 1px solid var(--risu-danger); color: var(--risu-danger); padding: 0.875rem; border-radius: var(--risu-radius-md); font-size: 0.875rem; display: flex; align-items: center; gap: 0.5rem;"
                    >
                        <Icon name=IconName::AlertCircle size=20 />
                        <span>{msg}</span>
                    </div>
                })}

                // Current Masked Configuration Card
                <Card>
                    <CardHeader title="Current Server Configuration" />
                    {move || if is_loading_config.get() {
                        view! {
                            <div style="padding: 1rem 0;">
                                <LoadingSpinner text="Reading /api/db-config..." />
                            </div>
                        }.into_any()
                    } else if let Some(cfg) = current_config.get() {
                        let conn_display = if cfg.connection_string.is_empty() {
                            "(none configured)".to_string()
                        } else {
                            cfg.connection_string
                        };
                        let backup_display = cfg.backup_connection_string.unwrap_or_else(|| "(none)".to_string());

                        view! {
                            <div style="display: flex; flex-direction: column; gap: 0.625rem; font-size: 0.875rem;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span style="color: var(--risu-theme-textcolor2);">"PostgreSQL Enabled"</span>
                                    <Badge variant=if cfg.enabled { BadgeVariant::Success } else { BadgeVariant::Neutral }>
                                        {if cfg.enabled { "Enabled" } else { "Disabled" }}
                                    </Badge>
                                </div>
                                <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                                    <span style="color: var(--risu-theme-textcolor2); font-size: 0.75rem;">"Active Masked URL"</span>
                                    <code style="background: var(--risu-theme-bgcolor); padding: 0.375rem 0.625rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-theme-darkborderc); font-size: 0.8125rem; word-break: break-all;">
                                        {conn_display}
                                    </code>
                                </div>
                                <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                                    <span style="color: var(--risu-theme-textcolor2); font-size: 0.75rem;">"Backup Masked URL"</span>
                                    <code style="background: var(--risu-theme-bgcolor); padding: 0.375rem 0.625rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-theme-darkborderc); font-size: 0.8125rem; word-break: break-all;">
                                        {backup_display}
                                    </code>
                                </div>
                            </div>
                        }.into_any()
                    } else {
                        view! {
                            <div style="color: var(--risu-danger); font-size: 0.875rem;">
                                "Could not load current configuration from server."
                            </div>
                        }.into_any()
                    }}
                </Card>

                // Configuration Input Form
                <div style="display: flex; flex-direction: column; gap: 1.25rem;">
                    // Enable Checkbox
                    <label style="display: flex; align-items: center; gap: 0.625rem; cursor: pointer; user-select: none;">
                        <input
                            type="checkbox"
                            style="width: 1.125rem; height: 1.125rem; accent-color: var(--risu-primary);"
                            prop:checked=move || enable_postgres.get()
                            on:change=move |ev| enable_postgres.set(event_target_checked(&ev))
                        />
                        <span style="font-weight: 600; font-size: 0.9375rem;">
                            "Enable PostgreSQL Database Backend"
                        </span>
                    </label>

                    // Connection String Obscured Input
                    <ObscuredInput
                        id="db-connection-string"
                        label="New Database Connection String"
                        placeholder="postgresql://username:password@localhost:5432/risuai"
                        value=connection_string_input.into()
                        on_change=move |v| connection_string_input.set(v)
                    />

                    // Backup Connection String Obscured Input
                    <ObscuredInput
                        id="db-backup-connection-string"
                        label="Backup Database Connection String (Optional)"
                        placeholder="postgresql://username:password@backup-host:5432/risuai"
                        value=backup_connection_string_input.into()
                        on_change=move |v| backup_connection_string_input.set(v)
                    />

                    // Test Connection Result feedback
                    {move || {
                        if let Some(latency) = test_latency.get() {
                            view! {
                                <div style="display: flex; align-items: center; gap: 0.5rem; color: var(--risu-success); font-size: 0.875rem; background: rgba(80, 250, 123, 0.1); padding: 0.5rem 0.75rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-success);">
                                    <Icon name=IconName::CheckCircle size=16 />
                                    <span>{format!("Test Successful! Connection Latency: {} ms", latency)}</span>
                                </div>
                            }.into_any()
                        } else if let Some(err) = test_error.get() {
                            view! {
                                <div style="display: flex; align-items: center; gap: 0.5rem; color: var(--risu-danger); font-size: 0.875rem; background: rgba(255, 85, 85, 0.1); padding: 0.5rem 0.75rem; border-radius: var(--risu-radius-sm); border: 1px solid var(--risu-danger);">
                                    <Icon name=IconName::AlertCircle size=16 />
                                    <span>{format!("Connection Test Failed: {}", err)}</span>
                                </div>
                            }.into_any()
                        } else {
                            ().into_any()
                        }
                    }}
                </div>

                // Actions Button Bar
                <div style="display: flex; flex-direction: column; gap: 0.75rem; border-top: 1px solid var(--risu-theme-darkborderc); padding-top: 1.25rem;">
                    <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
                        <Button
                            variant=ButtonVariant::Secondary
                            loading=is_testing.get()
                            disabled=is_testing.get() || is_saving.get() || is_retrying.get()
                            on_click=move |_| handle_test()
                        >
                            <Icon name=IconName::HeartPulse size=16 />
                            <span>"Test Connection"</span>
                        </Button>

                        <Button
                            variant=ButtonVariant::Primary
                            loading=is_saving.get()
                            disabled=is_saving.get() || is_testing.get() || is_retrying.get()
                            on_click=move |_| handle_save()
                        >
                            <Icon name=IconName::Check size=16 />
                            <span>"Save & Apply Configuration"</span>
                        </Button>

                        <Button
                            variant=ButtonVariant::Ghost
                            loading=is_retrying.get()
                            disabled=is_retrying.get() || is_saving.get() || is_testing.get()
                            on_click=move |_| handle_retry()
                        >
                            <Icon name=IconName::Refresh size=16 />
                            <span>"Retry Existing Config"</span>
                        </Button>
                    </div>

                    <div style="display: flex; justify-content: flex-end; margin-top: 0.5rem;">
                        <Button
                            variant=ButtonVariant::Ghost
                            on_click=move |_| state.logout()
                        >
                            <Icon name=IconName::LogOut size=16 />
                            <span>"Log Out"</span>
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    }
}
