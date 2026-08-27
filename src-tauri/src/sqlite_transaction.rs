use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};
use std::path::Path;
use tauri::{Emitter, Manager};

const REVISION_CONFLICT_PREFIX: &str = "RISU_SQL_REVISION_CONFLICT:";
const TRANSACTION_PROGRESS_EVENT: &str = "risu-sqlite-transaction-progress";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SqliteTransactionProgress {
    transaction_id: String,
    completed: usize,
    total: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteTransactionStatement {
    sql: String,
    #[serde(default)]
    bind: Vec<JsonValue>,
}

fn connect_options(db_path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true)
}

async fn execute_statement(
    connection: &mut SqliteConnection,
    statement: &SqliteTransactionStatement,
) -> Result<(), String> {
    let mut query = sqlx::query(&statement.sql);
    for value in statement.bind.iter().cloned() {
        if value.is_null() {
            query = query.bind(None::<JsonValue>);
        } else if let Some(text) = value.as_str() {
            query = query.bind(text.to_owned());
        } else if let Some(number) = value.as_number() {
            query = query.bind(number.as_f64().unwrap_or_default());
        } else {
            query = query.bind(value);
        }
    }
    query
        .execute(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn rollback(connection: &mut SqliteConnection) {
    let _ = sqlx::query("ROLLBACK").execute(connection).await;
}

#[tauri::command]
pub async fn sqlite_execute_transaction(
    app: tauri::AppHandle,
    expected_revision: Option<i64>,
    statements: Vec<SqliteTransactionStatement>,
    transaction_id: Option<String>,
) -> Result<(), String> {
    let db_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("risuai-local.sqlite3");
    let progress_app = app.clone();
    let progress_id = transaction_id.unwrap_or_default();
    execute_transaction_at_path_with_progress(
        &db_path,
        expected_revision,
        statements,
        move |completed, total| {
            if progress_id.is_empty() {
                return;
            }
            let _ = progress_app.emit(
                TRANSACTION_PROGRESS_EVENT,
                SqliteTransactionProgress {
                    transaction_id: progress_id.clone(),
                    completed,
                    total,
                },
            );
        },
    )
    .await
}

#[cfg(test)]
async fn execute_transaction_at_path(
    db_path: &Path,
    expected_revision: Option<i64>,
    statements: Vec<SqliteTransactionStatement>,
) -> Result<(), String> {
    execute_transaction_at_path_with_progress(db_path, expected_revision, statements, |_, _| {})
        .await
}

async fn execute_transaction_at_path_with_progress<F>(
    db_path: &Path,
    expected_revision: Option<i64>,
    statements: Vec<SqliteTransactionStatement>,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(usize, usize),
{
    let options = connect_options(db_path);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|error| error.to_string())?;

    if let Some(expected_revision) = expected_revision {
        let current_revision = match sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM system_storage_meta WHERE singleton = 1",
        )
        .fetch_optional(&mut connection)
        .await
        {
            Ok(value) => value.unwrap_or(0),
            Err(error) => {
                rollback(&mut connection).await;
                return Err(error.to_string());
            }
        };
        if current_revision != expected_revision {
            rollback(&mut connection).await;
            return Err(format!("{REVISION_CONFLICT_PREFIX}{current_revision}"));
        }
    }

    let total = statements.len();
    let progress_interval = (total / 100).max(1);
    on_progress(0, total);
    for (index, statement) in statements.iter().enumerate() {
        if let Err(error) = execute_statement(&mut connection, statement).await {
            rollback(&mut connection).await;
            return Err(error);
        }
        let completed = index + 1;
        if completed == total || completed % progress_interval == 0 {
            on_progress(completed, total);
        }
    }

    if let Err(error) = sqlx::query("COMMIT").execute(&mut connection).await {
        rollback(&mut connection).await;
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn test_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "risuai-sqlite-transaction-{}.sqlite3",
            Uuid::new_v4()
        ))
    }

    async fn setup(path: &std::path::Path) -> SqliteConnection {
        let options = connect_options(path);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE system_storage_meta (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL)")
            .execute(&mut connection).await.unwrap();
        sqlx::query("INSERT INTO system_storage_meta VALUES (1, 0)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&mut connection)
            .await
            .unwrap();
        connection
    }

    fn statement(sql: &str, bind: Vec<JsonValue>) -> SqliteTransactionStatement {
        SqliteTransactionStatement {
            sql: sql.to_owned(),
            bind,
        }
    }

    #[tokio::test]
    async fn rolls_back_the_entire_batch_on_failure() {
        let path = test_path();
        let mut connection = setup(&path).await;
        drop(connection);
        let result = execute_transaction_at_path(
            &path,
            Some(0),
            vec![
                statement(
                    "INSERT INTO data VALUES (?, ?)",
                    vec![1.into(), "one".into()],
                ),
                statement(
                    "INSERT INTO data VALUES (?, ?)",
                    vec![1.into(), "duplicate".into()],
                ),
            ],
        )
        .await;
        assert!(result.is_err());
        connection = SqliteConnection::connect_with(&connect_options(&path))
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM data")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }
    #[tokio::test]
    async fn rejects_stale_revision_before_writing() {
        let path = test_path();
        let mut connection = setup(&path).await;
        sqlx::query("UPDATE system_storage_meta SET revision = 2 WHERE singleton = 1")
            .execute(&mut connection)
            .await
            .unwrap();
        drop(connection);
        let result = execute_transaction_at_path(
            &path,
            Some(1),
            vec![statement(
                "INSERT INTO data VALUES (?, ?)",
                vec![1.into(), "must-not-write".into()],
            )],
        )
        .await;
        assert_eq!(result.unwrap_err(), format!("{REVISION_CONFLICT_PREFIX}2"));
        connection = SqliteConnection::connect_with(&connect_options(&path))
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM data")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn reports_statement_progress() {
        let path = test_path();
        let connection = setup(&path).await;
        drop(connection);
        let mut progress = Vec::new();
        execute_transaction_at_path_with_progress(
            &path,
            Some(0),
            vec![
                statement(
                    "INSERT INTO data VALUES (?, ?)",
                    vec![1.into(), "one".into()],
                ),
                statement(
                    "INSERT INTO data VALUES (?, ?)",
                    vec![2.into(), "two".into()],
                ),
            ],
            |completed, total| progress.push((completed, total)),
        )
        .await
        .unwrap();
        assert_eq!(progress, vec![(0, 2), (1, 2), (2, 2)]);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlx_query_executes_full_storage_schema_batch() {
        let path = test_path();
        let options = connect_options(&path);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query(include_str!("../../src/ts/storage/sqlite-schema.sql"))
            .execute(&mut connection)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('system_storage_meta', 'messages', 'cold_archives')",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(count, 3);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }
}
