use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use reqwest::Client;
use risuai_core::security::sanitize_target_url;

pub async fn proxy_handler(req: Request) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();

    let target_url: Option<String> = if let Some(query_str) = uri.query() {
        query_str.split('&').find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            if parts.next() == Some("url") {
                parts
                    .next()
                    .and_then(|u| urlencoding::decode(u).ok())
                    .map(|s| s.into_owned())
            } else {
                None
            }
        })
    } else {
        None
    };

    let target_url = match target_url {
        Some(u) => match sanitize_target_url(&u) {
            Some(sanitized) => sanitized,
            None => return (StatusCode::BAD_REQUEST, "Invalid target URL").into_response(),
        },
        None => return (StatusCode::BAD_REQUEST, "Missing target URL").into_response(),
    };

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .unwrap_or_default();

    let body_bytes = axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024)
        .await
        .unwrap_or_default();

    let mut req_builder = client.request(method, &target_url);

    for (k, v) in &headers {
        let lower = k.as_str().to_lowercase();
        if !["host", "connection", "risu-auth", "content-length"].contains(&lower.as_str()) {
            if let Ok(s) = v.to_str() {
                req_builder = req_builder.header(k.as_str(), s);
            }
        }
    }

    if !body_bytes.is_empty() {
        req_builder = req_builder.body(body_bytes);
    }

    match req_builder.send().await {
        Ok(resp) => {
            let status = resp.status();
            let mut resp_builder = Response::builder().status(status.as_u16());

            for (k, v) in resp.headers() {
                let lower = k.as_str().to_lowercase();
                if lower == "set-cookie" || lower == "content-type" || lower.starts_with("x-") {
                    resp_builder = resp_builder.header(k.as_str(), v.as_bytes());
                }
            }

            let body_stream = resp.bytes_stream();
            let body = axum::body::Body::from_stream(body_stream);
            resp_builder.body(body).unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "Response build error").into_response()
            })
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("Proxy request failed: {}", e),
        )
            .into_response(),
    }
}
