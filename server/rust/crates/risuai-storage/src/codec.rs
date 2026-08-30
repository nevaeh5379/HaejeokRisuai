use serde_json::Value;

pub fn sanitize_null_bytes(val: &mut Value) {
    match val {
        Value::String(s) => {
            if s.contains('\0') {
                *s = s.replace('\0', "");
            }
        }
        Value::Array(arr) => {
            for item in arr {
                sanitize_null_bytes(item);
            }
        }
        Value::Object(map) => {
            for (_, item) in map {
                sanitize_null_bytes(item);
            }
        }
        _ => {}
    }
}

pub fn sanitize_string(s: &str) -> String {
    if s.contains('\0') {
        s.replace('\0', "")
    } else {
        s.to_string()
    }
}

pub fn json_to_string_or_empty(val: Option<&Value>) -> String {
    match val {
        Some(Value::String(s)) => sanitize_string(s),
        Some(v) => sanitize_string(&v.to_string()),
        None => String::new(),
    }
}

pub fn extract_id(val: &Value) -> Option<String> {
    val.get("id").and_then(|v| v.as_str()).map(sanitize_string)
}

pub fn compute_hash(data: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(data.as_bytes());
    hex::encode(hasher.finalize())
}
