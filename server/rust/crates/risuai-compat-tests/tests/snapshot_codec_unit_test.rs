use risuai_storage::models::{
    CharactersSection, ChatsSection, EntityUpsert, RootSection, SettingUpsert, SyncPayload,
};
use serde_json::json;

#[test]
fn test_complex_database_snapshot_schema_codec() {
    let complex_snapshot = json!({
        "version": 4,
        "revision": 12,
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
                    "id": "char-101",
                    "name": "Elysia",
                    "image": "elysia.png",
                    "customBackground": "castle.png",
                    "firstMessage": "Greetings, noble traveler.",
                    "emotionImages": [["happy", "elysia_happy.png"]],
                    "additionalAssets": [["song.mp3", "assets/song.mp3", "mp3"]]
                }
            ],
            "chats": [
                {
                    "id": "chat-202",
                    "characterId": "char-101",
                    "name": "First Meeting",
                    "folderId": "f-1",
                    "lastMessage": "Farewell."
                }
            ],
            "messages": [
                {
                    "id": "msg-301",
                    "chatId": "chat-202",
                    "role": "user",
                    "content": "Hello Elysia!",
                    "timestamp": 1700000000000i64
                },
                {
                    "id": "msg-302",
                    "chatId": "chat-202",
                    "role": "char",
                    "content": "A pleasure to meet you.",
                    "timestamp": 1700000001000i64
                }
            ]
        }
    });

    let db = &complex_snapshot["database"];
    assert_eq!(db["settings"]["userTheme"], "neon-dark");
    assert_eq!(db["characters"][0]["id"], "char-101");
    assert_eq!(db["chats"][0]["id"], "chat-202");
    assert_eq!(db["messages"].as_array().unwrap().len(), 2);
}

#[test]
fn test_sync_payload_codec_serialization() {
    let payload = SyncPayload {
        base_revision: Some(5),
        replace_all: Some(false),
        root: Some(RootSection {
            upserts: vec![SettingUpsert {
                key: "autoSave".to_string(),
                value: json!(true),
            }],
            deletes: vec!["oldKey".to_string()],
        }),
        characters: Some(CharactersSection {
            upserts: vec![EntityUpsert {
                id: "c1".to_string(),
                position: Some(0),
                character_id: None,
                chat_id: None,
                data: json!({ "name": "Character 1" }),
            }],
            deletes: vec!["c_del".to_string()],
            order: vec!["c1".to_string()],
        }),
        chats: Some(ChatsSection {
            upserts: vec![EntityUpsert {
                id: "ch1".to_string(),
                position: Some(0),
                character_id: Some("c1".to_string()),
                chat_id: None,
                data: json!({ "name": "Chat 1" }),
            }],
            deletes: vec![],
            order: vec!["ch1".to_string()],
        }),
        ..Default::default()
    };

    let serialized = serde_json::to_string(&payload).unwrap();
    let deserialized: SyncPayload = serde_json::from_str(&serialized).unwrap();

    assert_eq!(deserialized.base_revision, Some(5));
    assert_eq!(
        deserialized.root.as_ref().unwrap().upserts[0].key,
        "autoSave"
    );
    assert_eq!(deserialized.root.as_ref().unwrap().deletes[0], "oldKey");
    assert_eq!(
        deserialized.characters.as_ref().unwrap().upserts[0].id,
        "c1"
    );
    assert_eq!(
        deserialized.characters.as_ref().unwrap().deletes[0],
        "c_del"
    );
    assert_eq!(deserialized.chats.as_ref().unwrap().upserts[0].id, "ch1");
}
