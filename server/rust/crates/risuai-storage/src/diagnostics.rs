use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

pub async fn test_postgres_connection(connection_string: &str) -> Result<u64, String> {
    let start = std::time::Instant::now();
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect(connection_string)
        .await
        .map_err(|e| format!("Failed to connect to PostgreSQL: {}", e))?;

    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to execute query: {}", e))?;

    Ok(start.elapsed().as_millis() as u64)
}

pub fn mask_sensitive_connection_string(conn_str: &str) -> String {
    if let Ok(mut url) = url::Url::parse(conn_str) {
        if url.password().is_some() {
            let _ = url.set_password(Some("*****"));
        }
        url.to_string()
    } else {
        "*****".to_string()
    }
}
