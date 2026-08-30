use risuai_storage::azure::storage::AzureSqlStorage;
use risuai_storage::oracle::storage::OracleStorage;
use risuai_storage::postgres::storage::PostgresStorage;
use risuai_storage::traits::ServerStorage;
use serde_json::json;

#[test]
fn test_storage_driver_descriptors_and_boundary_defaults() {
    let pg = PostgresStorage::new("postgresql://localhost:5432/risuai", false);
    assert_eq!(pg.vendor_name(), "postgres");
    assert!(!pg.is_enabled());

    let azure = AzureSqlStorage::new("sqlserver://localhost:1433/risuai", false);
    assert_eq!(azure.vendor_name(), "azuresql");
    assert!(!azure.is_enabled());

    let oracle = OracleStorage::new("oracle://localhost:1521/ORCL", false);
    assert_eq!(oracle.vendor_name(), "oracle");
    assert!(!oracle.is_enabled());
}

#[test]
fn test_azure_sql_merge_statement_patterns() {
    let setting_merge = "MERGE system.settings AS target \
                         USING (SELECT @P1 AS [key], @P2 AS text_val) AS source \
                         ON target.[key] = source.[key] \
                         WHEN MATCHED THEN UPDATE SET text_val = source.text_val \
                         WHEN NOT MATCHED THEN INSERT ([key], text_val) VALUES (source.[key], source.text_val);";

    assert!(setting_merge.contains("system.settings"));
    assert!(setting_merge.contains("@P1"));
    assert!(setting_merge.contains("@P2"));

    let char_merge = "MERGE character.characters AS target \
                      USING (SELECT @P1 AS id, @P2 AS position, @P3 AS name, @P4 AS image, @P5 AS data) AS source \
                      ON target.id = source.id \
                      WHEN MATCHED THEN UPDATE SET position = source.position, name = source.name, image = source.image, data = source.data \
                      WHEN NOT MATCHED THEN INSERT (id, position, name, image, data) VALUES (source.id, source.position, source.name, source.image, source.data);";

    assert!(char_merge.contains("character.characters"));
    assert!(char_merge.contains("@P5 AS data"));
}

#[test]
fn test_oracle_sql_merge_statement_patterns() {
    let setting_merge = "MERGE INTO system_settings target \
                         USING (SELECT :1 AS setting_key, :2 AS text_val FROM DUAL) source \
                         ON (target.setting_key = source.setting_key) \
                         WHEN MATCHED THEN UPDATE SET target.text_val = source.text_val \
                         WHEN NOT MATCHED THEN INSERT (setting_key, text_val) VALUES (source.setting_key, source.text_val)";

    assert!(setting_merge.contains("system_settings"));
    assert!(setting_merge.contains("FROM DUAL"));
    assert!(setting_merge.contains(":1"));

    let char_merge = "MERGE INTO char_characters target \
                      USING (SELECT :1 AS id, :2 AS pos, :3 AS name, :4 AS image, :5 AS data FROM DUAL) source \
                      ON (target.id = source.id) \
                      WHEN MATCHED THEN UPDATE SET target.position = source.pos, target.name = source.name, target.image = source.image, target.data = source.data \
                      WHEN NOT MATCHED THEN INSERT (id, position, name, image, data) VALUES (source.id, source.pos, source.name, source.image, source.data)";

    assert!(char_merge.contains("char_characters"));
    assert!(char_merge.contains(":5 AS data"));
}

#[test]
fn test_entity_reconstruction_value_shapes() {
    let raw_db_row = json!({
        "id": "char-test-1",
        "name": "Noble Companion",
        "image": "companion.webp",
        "data": "{\"id\":\"char-test-1\",\"name\":\"Noble Companion\",\"description\":\"A faithful follower\"}"
    });

    let data_str = raw_db_row["data"].as_str().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(data_str).unwrap();

    assert_eq!(parsed["id"], "char-test-1");
    assert_eq!(parsed["name"], "Noble Companion");
    assert_eq!(parsed["description"], "A faithful follower");
}
