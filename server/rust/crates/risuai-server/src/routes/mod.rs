pub mod assets;
pub mod auth;
pub mod compute;
pub mod database_v2;
pub mod db_config;
pub mod export;
pub mod health;
pub mod model_jobs;
pub mod proxy;
pub mod proxy_ws;
pub mod realtime;
pub mod s3_storage;
pub mod static_files;

use axum::routing::{delete, get, patch, post, put};
use axum::Router;

use crate::middleware::{auth_middleware, recovery_middleware};
use crate::state::AppState;

pub const RUST_ROUTE_MANIFEST: &[(&str, &str)] = &[
    ("GET", "/"),
    ("GET", "/api/realtime/events"),
    ("POST", "/api/realtime/generation-state"),
    ("GET", "/proxy"),
    ("GET", "/proxy2"),
    ("GET", "/hub-proxy/{*path}"),
    ("POST", "/proxy"),
    ("POST", "/proxy2"),
    ("POST", "/hub-proxy/{*path}"),
    ("POST", "/proxy-stream-jobs"),
    ("DELETE", "/proxy-stream-jobs/{jobId}"),
    ("GET", "/api/password"),
    ("GET", "/api/test_auth"),
    ("GET", "/api/health"),
    ("POST", "/api/login"),
    ("POST", "/api/crypto"),
    ("POST", "/api/set_password"),
    ("POST", "/api/read-bulk"),
    ("POST", "/api/charx-export/jobs"),
    ("GET", "/api/charx-export/jobs/{jobId}"),
    ("GET", "/api/charx-export/{jobId}"),
    ("POST", "/api/charx-export"),
    ("POST", "/api/local-backup/export/jobs"),
    ("GET", "/api/local-backup/export/jobs/{jobId}"),
    ("GET", "/api/local-backup/export/{jobId}"),
    ("POST", "/api/write-bulk"),
    ("GET", "/api/postgres-config"),
    ("POST", "/api/postgres-config"),
    ("GET", "/api/db-config"),
    ("POST", "/api/db-config/test"),
    ("POST", "/api/db-config/retry"),
    ("POST", "/api/db-config"),
    ("POST", "/api/database-v2/migrate-legacy"),
    ("GET", "/api/db-backup"),
    ("POST", "/api/db-backup/test"),
    ("POST", "/api/db-backup"),
    ("POST", "/api/db-backup/resync"),
    ("POST", "/api/db-backup/restore"),
    ("DELETE", "/api/db-backup"),
    ("POST", "/api/tokenize-count"),
    ("POST", "/api/lore-match-batch"),
    ("POST", "/api/lore-resolve"),
    ("POST", "/api/vector-index/status"),
    ("POST", "/api/vector-index/upsert"),
    ("POST", "/api/vector-index/search"),
    ("GET", "/api/vector-index/cache"),
    ("DELETE", "/api/vector-index/cache"),
    ("GET", "/api/database-v2/startup"),
    ("GET", "/api/database-v2/export"),
    ("GET", "/api/database-v2/plugins"),
    ("PATCH", "/api/database-v2/plugins/{pluginName}/enabled"),
    ("GET", "/api/database-v2/plugin-custom-storage/keys"),
    ("GET", "/api/database-v2/plugin-custom-storage/keys/{key}"),
    ("GET", "/api/database-v2/plugin-custom-storage"),
    ("GET", "/api/database-v2/plugins-data"),
    ("GET", "/api/database-v2/personas"),
    ("GET", "/api/database-v2/presets"),
    ("GET", "/api/database-v2/presets/{id}"),
    ("GET", "/api/database-v2/lorebooks"),
    ("GET", "/api/database-v2/modules"),
    ("GET", "/api/database-v2/prompts"),
    ("GET", "/api/database-v2/scripts"),
    ("GET", "/api/database-v2/settings/{key}"),
    ("GET", "/api/database-v2/characters/{characterId}"),
    (
        "GET",
        "/api/database-v2/characters/{characterId}/asset-fields",
    ),
    ("GET", "/api/database-v2/chats/{chatId}"),
    ("GET", "/api/database-v2/chats/{chatId}/messages"),
    ("GET", "/api/database-v2/revisions"),
    ("GET", "/api/database-v2/revisions/diff"),
    ("GET", "/api/database-v2/revisions/{id}/details"),
    ("POST", "/api/database-v2/revisions/preview-restore"),
    ("POST", "/api/database-v2/revisions/restore"),
    ("POST", "/api/database-v2/commit"),
    ("PUT", "/api/db/settings/{key}"),
    ("DELETE", "/api/db/settings/{key}"),
    ("POST", "/api/db/bot-presets"),
    ("POST", "/api/db/modules"),
    ("DELETE", "/api/db/modules/{id}"),
    ("POST", "/api/db/chats/{chatId}/messages"),
    ("DELETE", "/api/db/chats/{chatId}/messages/{messageId}"),
    ("GET", "/api/database-v2/cold-storage"),
    ("GET", "/api/database-v2/cold-storage/{key}"),
    ("PUT", "/api/database-v2/cold-storage/{key}"),
    ("DELETE", "/api/database-v2/cold-storage"),
    ("POST", "/api/database-v2/cold-storage/prune"),
    ("GET", "/api/database-v2/search"),
    ("GET", "/api/database-v2/token-usage"),
    ("GET", "/api/database-v2/bot-stats"),
    ("GET", "/api/database-v2/characters/search"),
    ("GET", "/api/database-v2/tables"),
    ("GET", "/api/database-v2/tables/{table}/rows"),
    ("GET", "/api/s3-config"),
    ("POST", "/api/s3-config"),
    ("POST", "/api/s3-test"),
    ("GET", "/api/s3-stats"),
    ("GET", "/api/storage-summary"),
    ("GET", "/api/s3-asset-details"),
    ("POST", "/api/storage-assets-delete"),
    ("POST", "/api/storage-local-clean"),
    ("POST", "/api/s3-migrate"),
    ("POST", "/api/s3-rollback"),
    ("POST", "/api/s3-generate-thumbnails"),
    ("GET", "/api/read"),
    ("GET", "/api/remove"),
    ("GET", "/api/list"),
    ("POST", "/api/asset-catalog/resync"),
    ("POST", "/api/write"),
    ("GET", "/api/oauth_login"),
    ("GET", "/api/oauth_callback"),
    ("POST", "/api/chat-executor/plan"),
    ("POST", "/api/chat-executor/continuation"),
    ("POST", "/api/hypa-memory/start"),
    ("POST", "/api/hypa-memory/{sessionId}/continue"),
    ("DELETE", "/api/hypa-memory/{sessionId}"),
    ("POST", "/api/model-jobs"),
    ("GET", "/api/model-jobs"),
    ("GET", "/api/model-jobs/{id}/stream"),
    ("GET", "/api/model-jobs/{id}"),
    ("POST", "/api/model-jobs/{id}/claim"),
    ("DELETE", "/api/model-jobs/{id}"),
    ("GET", "/api/chat-executor/providers"),
    ("POST", "/api/chat-executor/provider"),
    ("POST", "/api/chat-executor/transport"),
];

pub fn get_registered_routes() -> Vec<(&'static str, &'static str)> {
    RUST_ROUTE_MANIFEST.to_vec()
}

pub fn build_router(state: AppState) -> Router {
    let api_router = Router::new()
        // Health & Auth
        .route("/api/health", get(health::health_handler))
        .route("/api/password", get(auth::test_auth_handler))
        .route("/api/test_auth", get(auth::test_auth_handler))
        .route("/api/login", post(auth::login_handler))
        .route("/api/set_password", post(auth::set_password_handler))
        .route("/api/crypto", post(auth::crypto_handler))
        .route("/api/oauth_login", get(auth::oauth_login_handler))
        .route("/api/oauth_callback", get(auth::oauth_callback_handler))
        // DB Config & Postgres Config
        .route(
            "/api/db-config",
            get(db_config::get_db_config_handler).post(db_config::update_db_config_handler),
        )
        .route(
            "/api/db-config/test",
            post(db_config::test_db_config_handler),
        )
        .route(
            "/api/db-config/retry",
            post(db_config::retry_db_config_handler),
        )
        .route(
            "/api/postgres-config",
            get(db_config::get_db_config_handler).post(db_config::update_db_config_handler),
        )
        // DB Backup
        .route(
            "/api/db-backup",
            get(db_config::get_db_backup_config_handler)
                .post(db_config::update_db_backup_config_handler)
                .delete(db_config::delete_db_backup_handler),
        )
        .route(
            "/api/db-backup/test",
            post(db_config::test_db_config_handler),
        )
        .route(
            "/api/db-backup/resync",
            post(db_config::db_backup_resync_handler),
        )
        .route(
            "/api/db-backup/restore",
            post(db_config::db_backup_restore_handler),
        )
        .route(
            "/api/db-backup/config",
            get(db_config::get_db_backup_config_handler)
                .post(db_config::update_db_backup_config_handler),
        )
        .route(
            "/api/db-backup/sync",
            post(db_config::sync_db_backup_handler),
        )
        // Database V2 Core
        .route(
            "/api/database-v2/state",
            get(database_v2::get_database_state_handler),
        )
        .route(
            "/api/database-v2/commit",
            post(database_v2::commit_database_handler),
        )
        .route(
            "/api/database-v2/startup",
            get(database_v2::startup_data_handler),
        )
        .route(
            "/api/database-v2/setting-keys",
            post(database_v2::setting_keys_handler),
        )
        .route(
            "/api/database-v2/migrate-legacy",
            post(database_v2::migrate_legacy_handler),
        )
        .route(
            "/api/database-v2/export",
            get(database_v2::get_database_export_handler),
        )
        .route(
            "/api/database-v2/snapshot",
            get(database_v2::get_snapshot_handler).post(database_v2::post_snapshot_handler),
        )
        // Database V2 Relational Entities
        .route(
            "/api/database-v2/plugins",
            get(database_v2::get_plugins_handler).post(database_v2::save_plugins_handler),
        )
        .route(
            "/api/database-v2/plugins/{pluginName}/enabled",
            patch(database_v2::patch_plugin_enabled_handler),
        )
        .route(
            "/api/database-v2/plugins-data",
            get(database_v2::get_plugins_data_handler),
        )
        .route(
            "/api/database-v2/plugin-custom-storage",
            get(database_v2::get_plugin_custom_storage_handler),
        )
        .route(
            "/api/database-v2/plugin-custom-storage/keys",
            get(database_v2::get_plugin_custom_storage_keys_handler),
        )
        .route(
            "/api/database-v2/plugin-custom-storage/keys/{key}",
            get(database_v2::get_plugin_custom_storage_key_handler),
        )
        .route(
            "/api/database-v2/personas",
            get(database_v2::get_personas_handler).post(database_v2::save_persona_handler),
        )
        .route(
            "/api/database-v2/presets",
            get(database_v2::get_presets_handler).post(database_v2::save_preset_handler),
        )
        .route(
            "/api/database-v2/presets/{id}",
            get(database_v2::get_preset_handler),
        )
        .route(
            "/api/database-v2/lorebooks",
            get(database_v2::get_lorebooks_handler).post(database_v2::save_lorebook_handler),
        )
        .route(
            "/api/database-v2/modules",
            get(database_v2::get_modules_handler).post(database_v2::save_module_handler),
        )
        .route(
            "/api/database-v2/prompts",
            get(database_v2::get_prompts_handler).post(database_v2::save_prompt_handler),
        )
        .route(
            "/api/database-v2/scripts",
            get(database_v2::get_scripts_handler).post(database_v2::save_script_handler),
        )
        .route(
            "/api/database-v2/settings/{key}",
            get(database_v2::get_setting_handler)
                .post(database_v2::update_setting_handler)
                .delete(database_v2::delete_setting_handler),
        )
        .route(
            "/api/database-v2/characters/{characterId}",
            get(database_v2::get_character_handler)
                .post(database_v2::save_character_handler)
                .delete(database_v2::delete_character_handler),
        )
        .route(
            "/api/database-v2/characters/{characterId}/asset-fields",
            get(database_v2::get_character_assets_handler),
        )
        .route(
            "/api/database-v2/characters/search",
            get(database_v2::search_characters_handler),
        )
        .route(
            "/api/database-v2/chats/{chatId}",
            get(database_v2::get_chat_handler)
                .post(database_v2::save_chat_handler)
                .delete(database_v2::delete_chat_handler),
        )
        .route(
            "/api/database-v2/chats/{chatId}/messages",
            get(database_v2::get_chat_messages_handler).post(database_v2::save_message_handler),
        )
        .route(
            "/api/database-v2/chats/{chatId}/messages/{messageId}",
            delete(database_v2::delete_message_handler),
        )
        // Database V2 Revisions
        .route(
            "/api/database-v2/revisions",
            get(database_v2::list_revisions_handler),
        )
        .route(
            "/api/database-v2/revisions/diff",
            get(database_v2::get_revision_diff_handler),
        )
        .route(
            "/api/database-v2/revisions/{id}/details",
            get(database_v2::get_revision_details_handler),
        )
        .route(
            "/api/database-v2/revision/{id}",
            get(database_v2::get_revision_details_handler),
        )
        .route(
            "/api/database-v2/revisions/preview-restore",
            post(database_v2::preview_restore_handler),
        )
        .route(
            "/api/database-v2/revision/{id}/preview",
            get(database_v2::preview_restore_handler),
        )
        .route(
            "/api/database-v2/revisions/restore",
            post(database_v2::restore_revision_handler),
        )
        .route(
            "/api/database-v2/revision/{id}/restore",
            post(database_v2::restore_revision_handler),
        )
        // Database V2 Cold Storage
        .route(
            "/api/database-v2/cold-storage",
            get(database_v2::list_cold_storage_handler)
                .delete(database_v2::delete_cold_storage_handler),
        )
        .route(
            "/api/database-v2/cold-storage/{key}",
            get(database_v2::get_cold_storage_handler)
                .put(database_v2::put_cold_storage_handler)
                .delete(database_v2::delete_cold_storage_handler),
        )
        .route(
            "/api/database-v2/cold-storage/prune",
            post(database_v2::prune_cold_storage_handler),
        )
        // Database V2 Tables & Stats
        .route(
            "/api/database-v2/tables",
            get(database_v2::list_tables_handler),
        )
        .route(
            "/api/database-v2/tables/{table}/rows",
            get(database_v2::get_table_rows_handler),
        )
        .route(
            "/api/database-v2/table/{table}",
            get(database_v2::get_table_rows_handler),
        )
        .route("/api/database-v2/search", get(database_v2::search_handler))
        .route(
            "/api/database-v2/token-usage",
            get(database_v2::token_stats_handler),
        )
        .route(
            "/api/database-v2/stats/tokens",
            get(database_v2::token_stats_handler),
        )
        .route(
            "/api/database-v2/bot-stats",
            get(database_v2::bot_stats_handler),
        )
        .route(
            "/api/database-v2/stats/bots",
            get(database_v2::bot_stats_handler),
        )
        // Direct /api/db/* mutations
        .route(
            "/api/db/settings/{key}",
            put(database_v2::update_setting_handler).delete(database_v2::delete_setting_handler),
        )
        .route(
            "/api/db/setting/{key}",
            post(database_v2::update_setting_handler).delete(database_v2::delete_setting_handler),
        )
        .route(
            "/api/db/bot-presets",
            post(database_v2::save_preset_handler),
        )
        .route("/api/db/preset", post(database_v2::save_preset_handler))
        .route(
            "/api/db/preset/{id}",
            put(database_v2::save_preset_handler).delete(database_v2::delete_module_handler),
        )
        .route("/api/db/modules", post(database_v2::save_module_handler))
        .route("/api/db/module", post(database_v2::save_module_handler))
        .route(
            "/api/db/module/{id}",
            put(database_v2::save_module_handler).delete(database_v2::delete_module_handler),
        )
        .route(
            "/api/db/modules/{id}",
            delete(database_v2::delete_module_handler),
        )
        .route(
            "/api/db/chats/{chatId}/messages",
            post(database_v2::save_message_handler),
        )
        .route(
            "/api/db/message/{chatId}",
            post(database_v2::save_message_handler),
        )
        .route(
            "/api/db/chats/{chatId}/messages/{messageId}",
            delete(database_v2::delete_message_handler),
        )
        .route(
            "/api/db/message/{chatId}/{messageId}",
            delete(database_v2::delete_message_handler),
        )
        // S3 / Storage Management
        .route(
            "/api/s3-config",
            get(s3_storage::get_s3_config_handler).post(s3_storage::update_s3_config_handler),
        )
        .route("/api/s3-test", post(s3_storage::test_s3_handler))
        .route("/api/s3-stats", get(s3_storage::get_s3_stats_handler))
        .route(
            "/api/storage-summary",
            get(s3_storage::storage_summary_handler),
        )
        .route(
            "/api/s3-asset-details",
            get(s3_storage::s3_asset_details_handler),
        )
        .route("/api/s3-migrate", post(s3_storage::s3_migrate_handler))
        .route("/api/s3-rollback", post(s3_storage::s3_rollback_handler))
        .route(
            "/api/s3-generate-thumbnails",
            post(s3_storage::s3_generate_thumbnails_handler),
        )
        .route(
            "/api/storage-assets-delete",
            post(s3_storage::storage_assets_delete_handler),
        )
        .route(
            "/api/storage-local-clean",
            post(s3_storage::storage_local_clean_handler),
        )
        .route("/api/db-hash", get(s3_storage::db_hash_handler))
        .route("/api/db-resolve", post(s3_storage::db_resolve_handler))
        .route(
            "/api/asset-catalog/resync",
            post(s3_storage::asset_catalog_resync_handler),
        )
        // Assets
        .route("/api/read", get(assets::read_asset_handler))
        .route("/api/read/{*path}", get(assets::read_asset_handler))
        .route("/api/write", post(assets::write_asset_handler))
        .route("/api/write/{*path}", post(assets::write_asset_handler))
        .route("/api/remove", get(assets::remove_asset_handler))
        .route("/api/list", get(assets::list_assets_handler))
        .route("/api/read-bulk", post(assets::read_bulk_handler))
        .route("/api/write-bulk", post(assets::write_bulk_handler))
        // Realtime & Model Jobs
        .route(
            "/api/realtime/events",
            get(realtime::realtime_events_handler),
        )
        .route(
            "/api/realtime/generation-state",
            post(realtime::update_generation_state_handler),
        )
        .route(
            "/api/model-jobs",
            get(model_jobs::list_model_jobs_handler).post(model_jobs::create_model_job_handler),
        )
        .route(
            "/api/model-jobs/{id}",
            get(model_jobs::get_model_job_handler).delete(model_jobs::delete_model_job_handler),
        )
        .route(
            "/api/model-jobs/{id}/stream",
            get(model_jobs::stream_model_job_handler),
        )
        .route(
            "/api/model-jobs/{id}/claim",
            post(model_jobs::claim_model_job_handler),
        )
        // Compute
        .route("/api/tokenize-count", post(compute::tokenize_count_handler))
        .route(
            "/api/lore-match-batch",
            post(compute::lore_match_batch_handler),
        )
        .route("/api/lore-resolve", post(compute::lore_resolve_handler))
        .route(
            "/api/vector-index/status",
            post(compute::vector_status_handler),
        )
        .route("/api/vector-index/sync", post(compute::vector_sync_handler))
        .route(
            "/api/vector-index/upsert",
            post(compute::vector_upsert_handler),
        )
        .route(
            "/api/vector-index/search",
            post(compute::vector_search_handler),
        )
        .route(
            "/api/vector-index/cache",
            get(compute::vector_cache_get_handler).delete(compute::vector_cache_clear_handler),
        )
        .route("/api/chat-executor/plan", post(compute::chat_plan_handler))
        .route(
            "/api/chat-executor/continuation",
            post(compute::chat_continuation_handler),
        )
        .route(
            "/api/chat-executor/providers",
            get(compute::chat_providers_handler),
        )
        .route(
            "/api/chat-executor/provider",
            post(compute::chat_provider_handler),
        )
        .route(
            "/api/chat-executor/transport",
            post(compute::chat_transport_handler),
        )
        .route("/api/hypa-memory/start", post(compute::hypa_start_handler))
        .route(
            "/api/hypa-memory/{sessionId}/continue",
            post(compute::hypa_resume_handler),
        )
        .route(
            "/api/hypa-memory/{sessionId}",
            delete(compute::hypa_cancel_handler),
        )
        // Exports
        .route(
            "/api/charx-export",
            post(export::charx_export_direct_handler),
        )
        .route(
            "/api/charx-export/jobs",
            post(export::charx_export_jobs_handler),
        )
        .route(
            "/api/charx-export/jobs/{jobId}",
            get(export::charx_export_job_status_handler),
        )
        .route(
            "/api/charx-export/{jobId}",
            get(export::charx_export_get_job_handler),
        )
        .route(
            "/api/local-backup/export/jobs",
            post(export::local_backup_export_jobs_handler),
        )
        .route(
            "/api/local-backup/export/jobs/{jobId}",
            get(export::local_backup_export_job_status_handler),
        )
        .route(
            "/api/local-backup/export/{jobId}",
            get(export::local_backup_export_get_job_handler),
        )
        // Proxy
        .route(
            "/proxy",
            get(proxy::proxy_handler).post(proxy::proxy_handler),
        )
        .route(
            "/proxy2",
            get(proxy::proxy_handler).post(proxy::proxy_handler),
        )
        .route(
            "/hub-proxy/{*path}",
            get(proxy::proxy_handler).post(proxy::proxy_handler),
        )
        .route(
            "/proxy-stream-jobs",
            post(proxy_ws::create_proxy_stream_job_handler),
        )
        .route(
            "/proxy-stream-jobs/{jobId}",
            delete(proxy_ws::delete_proxy_stream_job_handler),
        )
        .route(
            "/proxy-stream-jobs/{jobId}/ws",
            get(proxy_ws::proxy_stream_ws_handler),
        )
        // Layer with recovery & auth
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            recovery_middleware,
        ));

    Router::new()
        .merge(api_router)
        .fallback(static_files::static_files_handler)
        .with_state(state)
}
