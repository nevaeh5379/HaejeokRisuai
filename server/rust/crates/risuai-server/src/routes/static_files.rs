use axum::extract::{Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use std::path::Path;

use crate::state::AppState;
use risuai_assets::mime::get_content_type;

pub async fn static_files_handler(State(state): State<AppState>, req: Request) -> Response {
    let dist_dir = match &state.dist_dir {
        Some(d) if d.exists() => d.clone(),
        _ => return (StatusCode::NOT_FOUND, "Static directory not found").into_response(),
    };

    let path_str = req.uri().path().trim_start_matches('/');
    let target_path = if path_str.is_empty() {
        dist_dir.join("index.html")
    } else {
        dist_dir.join(path_str)
    };

    if target_path.exists() && target_path.is_file() {
        if path_str.is_empty() || path_str == "index.html" {
            return serve_index_html(&target_path).await;
        }

        if let Ok(data) = tokio::fs::read(&target_path).await {
            let content_type = get_content_type(target_path.to_str().unwrap_or(""));
            return Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, content_type)
                .header(CACHE_CONTROL, "public, max-age=31536000, immutable")
                .body(axum::body::Body::from(data))
                .unwrap();
        }
    }

    // SPA fallback to index.html
    let index_path = dist_dir.join("index.html");
    if index_path.exists() {
        serve_index_html(&index_path).await
    } else {
        (StatusCode::NOT_FOUND, "Not found").into_response()
    }
}

async fn serve_index_html(index_path: &Path) -> Response {
    if let Ok(mut html) = tokio::fs::read_to_string(index_path).await {
        // Inject script flag
        let injection = "<script>window.__RISU_IS_NODE_SERVER = true;</script>";
        if let Some(pos) = html.find("</head>") {
            html.insert_str(pos, injection);
        } else {
            html.push_str(injection);
        }

        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/html; charset=utf-8")
            .header(CACHE_CONTROL, "no-cache")
            .body(axum::body::Body::from(html))
            .unwrap()
    } else {
        (StatusCode::NOT_FOUND, "index.html not found").into_response()
    }
}
