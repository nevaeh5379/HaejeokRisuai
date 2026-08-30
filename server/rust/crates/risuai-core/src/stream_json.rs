use serde_json::Value;

pub fn serialize_to_json_stream_chunk(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(value)
}
