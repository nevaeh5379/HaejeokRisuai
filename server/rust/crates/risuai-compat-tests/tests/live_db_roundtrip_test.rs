use risuai_storage::azure::storage::AzureSqlStorage;
use risuai_storage::oracle::storage::OracleStorage;
use risuai_storage::postgres::storage::PostgresStorage;
use risuai_storage::traits::ServerStorage;
use serde_json::json;
use std::env;

fn get_complex_test_snapshot() -> serde_json::Value {
    json!({
        "version": 4,
        "revision": 1,
        "database": {
            "settings": {
                "userTheme": "neon-dark",
                "temperature": 0.85,
                "streaming": true,
                "personas": [
                    { "id": "p1", "name": "Adventurer", "description": "Traveler of realms" }
                ],
                "loreBook": [
                    { "id": "l1", "name": "World Lore", "entries": [{ "keys": ["magic"], "content": "Ancient art" }] }
                ],
                "modules": [
                    { "id": "m1", "name": "AutoTranslate", "enabled": true }
                ],
                "pluginCustomStorage": {
                    "plugin_alpha": { "customKey": "customValue" }
                }
            },
            "characters": [
                {
                    "id": "char-live-101",
                    "name": "Elysia Live",
                    "image": "elysia.png",
                    "customBackground": "castle.png",
                    "firstMessage": "Greetings, live noble traveler."
                }
            ],
            "chats": [
                {
                    "id": "chat-live-202",
                    "characterId": "char-live-101",
                    "name": "First Live Meeting"
                }
            ],
            "messages": [
                {
                    "id": "msg-live-301",
                    "chatId": "chat-live-202",
                    "role": "user",
                    "content": "Hello live Elysia!",
                    "timestamp": 1700000000000i64
                }
            ]
        }
    })
}

#[tokio::test]
async fn test_live_postgres_roundtrip_if_configured() {
    let pg_url = env::var("POSTGRES_URL")
        .or_else(|_| env::var("TEST_DATABASE_URL"))
        .ok();

    let url = match pg_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => {
            eprintln!("Skipping live PostgreSQL test: POSTGRES_URL or TEST_DATABASE_URL not set");
            return;
        }
    };

    let mut storage = PostgresStorage::new(&url, true);
    assert_eq!(storage.vendor_name(), "postgres");

    if let Err(e) = storage.connect().await {
        eprintln!("PostgreSQL connect failed in live test: {}", e);
        return;
    }

    let _ = storage.initialize().await;
    let snapshot = get_complex_test_snapshot();

    // 1. Import snapshot
    let import_res = storage.import_snapshot(snapshot.clone()).await;
    assert!(import_res.is_ok());

    // 2. Read startup data
    let startup = storage.load_startup_data().await.unwrap();
    assert_eq!(startup["status"], "ready");

    // 3. Lazy domains
    let personas = storage
        .load_setting_keys(&["personas".to_string()])
        .await
        .unwrap();
    assert!(personas["settings"]["personas"].as_array().is_some());

    // 4. Export snapshot and compare
    let exported = storage.export_snapshot().await.unwrap();
    assert_eq!(
        exported["database"]["settings"]["userTheme"],
        snapshot["database"]["settings"]["userTheme"]
    );
}

#[tokio::test]
async fn test_live_azure_sql_roundtrip_if_configured() {
    let azure_url = env::var("AZURE_SQL_URL")
        .or_else(|_| env::var("MSSQL_URL"))
        .ok();

    let url = match azure_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => {
            eprintln!("Skipping live Azure SQL test: AZURE_SQL_URL not set");
            return;
        }
    };

    let storage = AzureSqlStorage::new(&url, true);
    assert_eq!(storage.vendor_name(), "azuresql");

    if let Err(e) = storage.connect().await {
        eprintln!("Azure SQL connect failed in live test: {}", e);
        return;
    }

    let _ = storage.initialize().await;
    let snapshot = get_complex_test_snapshot();

    let import_res = storage.import_snapshot(snapshot.clone()).await;
    assert!(import_res.is_ok());

    let startup = storage.load_startup_data().await.unwrap();
    assert_eq!(startup["status"], "ready");

    let exported = storage.export_snapshot().await.unwrap();
    assert_eq!(
        exported["database"]["settings"]["userTheme"],
        snapshot["database"]["settings"]["userTheme"]
    );
}

#[tokio::test]
async fn test_live_oracle_roundtrip_if_configured() {
    let oracle_url = env::var("ORACLE_URL")
        .or_else(|_| env::var("ORACLE_DATABASE_URL"))
        .ok();

    let url = match oracle_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => {
            eprintln!("Skipping live Oracle test: ORACLE_URL not set");
            return;
        }
    };

    let storage = OracleStorage::new(&url, true);
    assert_eq!(storage.vendor_name(), "oracle");

    if let Err(e) = storage.connect().await {
        eprintln!("Oracle connect failed in live test: {}", e);
        return;
    }

    let _ = storage.initialize().await;
    let snapshot = get_complex_test_snapshot();

    let import_res = storage.import_snapshot(snapshot.clone()).await;
    assert!(import_res.is_ok());

    let startup = storage.load_startup_data().await.unwrap();
    assert_eq!(startup["status"], "ready");

    let exported = storage.export_snapshot().await.unwrap();
    assert_eq!(
        exported["database"]["settings"]["userTheme"],
        snapshot["database"]["settings"]["userTheme"]
    );
}
