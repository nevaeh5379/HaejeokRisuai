use regex::Regex;
use risuai_server::routes::get_registered_routes;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

fn extract_routes_from_cjs(file_content: &str) -> Vec<(String, String)> {
    let re = Regex::new(r#"app\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]"#).unwrap();
    let mut routes = Vec::new();

    for cap in re.captures_iter(file_content) {
        let method = cap[1].to_uppercase();
        let raw_path = cap[2].to_string();

        // Convert Express parameter syntax :paramName to Axum syntax {paramName}
        let param_re = Regex::new(r":([a-zA-Z0-9_]+)").unwrap();
        let axum_path = param_re.replace_all(&raw_path, "{$1}").to_string();

        routes.push((method, axum_path));
    }

    routes
}

#[test]
fn test_source_derived_route_parity() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let server_node_dir = manifest_dir.join("../../../../server/node");

    let mut node_routes = BTreeSet::new();

    let entries = fs::read_dir(&server_node_dir).unwrap_or_else(|e| {
        panic!(
            "Failed to read server/node directory at {:?}: {}",
            server_node_dir, e
        )
    });

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("cjs") {
            let content =
                fs::read_to_string(&path).unwrap_or_else(|_| panic!("Failed to read {:?}", path));
            let routes = extract_routes_from_cjs(&content);
            for r in routes {
                node_routes.insert(r);
            }
        }
    }

    assert!(
        !node_routes.is_empty(),
        "Should have parsed routes from server/node CJS files"
    );

    let rust_routes_manifest = get_registered_routes();
    let rust_routes: BTreeSet<(String, String)> = rust_routes_manifest
        .into_iter()
        .map(|(m, p)| (m.to_string(), p.to_string()))
        .collect();

    let missing_in_rust: Vec<_> = node_routes.difference(&rust_routes).collect();
    let extra_in_rust: Vec<_> = rust_routes.difference(&node_routes).collect();

    assert!(
        missing_in_rust.is_empty(),
        "Node routes missing in Rust server: {:#?}",
        missing_in_rust
    );

    assert!(
        extra_in_rust.is_empty(),
        "Invented Rust routes not found in Node server: {:#?}",
        extra_in_rust
    );

    println!(
        "Verified exact 1:1 route parity between Node ({}) and Rust ({}) routes.",
        node_routes.len(),
        rust_routes.len()
    );
}
