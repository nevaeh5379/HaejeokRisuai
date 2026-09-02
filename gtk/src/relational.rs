use std::collections::{HashMap, HashSet};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use thiserror::Error;

const MAX_DEPTH: usize = 128;
const MAX_ROWS: usize = 250_000;

#[derive(Clone, Debug, PartialEq)]
pub enum RelationalValue {
    Null,
    Undefined,
    Boolean(bool),
    Number(f64),
    String(String),
    Array(Vec<RelationalValue>),
    Object(Vec<(String, RelationalValue)>),
}

impl RelationalValue {
    pub fn get(&self, key: &str) -> Option<&Self> {
        let Self::Object(entries) = self else {
            return None;
        };
        entries
            .iter()
            .find_map(|(entry_key, value)| (entry_key == key).then_some(value))
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Boolean(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(values) => Some(values),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Self)]> {
        match self {
            Self::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn to_json_value(&self) -> Option<serde_json::Value> {
        match self {
            Self::Null | Self::Undefined => Some(serde_json::Value::Null),
            Self::Boolean(value) => Some((*value).into()),
            Self::Number(value) if value.is_finite() => {
                if value.fract() == 0.0 && *value >= i64::MIN as f64 && *value <= i64::MAX as f64 {
                    Some((*value as i64).into())
                } else {
                    serde_json::Number::from_f64(*value).map(serde_json::Value::Number)
                }
            }
            Self::Number(_) => None,
            Self::String(value) => Some(value.clone().into()),
            Self::Array(values) => values
                .iter()
                .map(Self::to_json_value)
                .collect::<Option<Vec<_>>>()
                .map(serde_json::Value::Array),
            Self::Object(entries) => entries
                .iter()
                .map(|(key, value)| Some((key.clone(), value.to_json_value()?)))
                .collect::<Option<serde_json::Map<_, _>>>()
                .map(serde_json::Value::Object),
        }
    }

    pub fn from_json_value(value: serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(value) => Self::Boolean(value),
            serde_json::Value::Number(value) => {
                Self::Number(value.as_f64().expect("JSON numbers are finite"))
            }
            serde_json::Value::String(value) => Self::String(value),
            serde_json::Value::Array(values) => {
                Self::Array(values.into_iter().map(Self::from_json_value).collect())
            }
            serde_json::Value::Object(entries) => Self::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, Self::from_json_value(value)))
                    .collect(),
            ),
        }
    }
}

#[derive(Clone, Debug)]
pub struct NodeRow {
    pub node_id: i64,
    pub parent_node_id: Option<i64>,
    pub node_order: i64,
    pub object_key: Option<String>,
    pub object_key_encoded: Option<String>,
    pub value_type: String,
    pub text_value: Option<String>,
    pub encoded_text_value: Option<String>,
    pub number_value: Option<f64>,
    pub boolean_value: Option<i64>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DecodeError {
    #[error("관계형 값에 루트 노드가 없습니다.")]
    MissingRoot,
    #[error("관계형 값의 행 수가 제한을 초과했습니다.")]
    TooManyRows,
    #[error("관계형 값의 깊이가 제한을 초과했습니다.")]
    TooDeep,
    #[error("중복된 관계형 노드 ID입니다: {0}")]
    DuplicateNode(i64),
    #[error("잘못된 관계형 루트 노드입니다.")]
    InvalidRoot,
    #[error("관계형 노드 {node}의 부모 {parent}가 없습니다.")]
    MissingParent { node: i64, parent: i64 },
    #[error("관계형 노드 그래프에 순환 또는 도달 불가능한 노드가 있습니다.")]
    InvalidGraph,
    #[error("객체 자식 노드 {0}에 키가 없습니다.")]
    MissingObjectKey(i64),
    #[error("지원하지 않는 관계형 값 타입입니다: {0}")]
    UnknownType(String),
    #[error("인코딩된 문자열이 올바른 Base64가 아닙니다.")]
    InvalidBase64,
    #[error("인코딩된 문자열 바이트 수가 홀수입니다.")]
    OddUtf16Length,
    #[error("인코딩된 문자열이 올바른 UTF-16이 아닙니다.")]
    InvalidUtf16,
}

pub fn decode_rows(rows: Vec<NodeRow>) -> Result<RelationalValue, DecodeError> {
    if rows.is_empty() {
        return Err(DecodeError::MissingRoot);
    }
    if rows.len() > MAX_ROWS {
        return Err(DecodeError::TooManyRows);
    }

    let mut nodes = HashMap::with_capacity(rows.len());
    for row in rows {
        let id = row.node_id;
        if nodes.insert(id, row).is_some() {
            return Err(DecodeError::DuplicateNode(id));
        }
    }
    let root = nodes.get(&0).ok_or(DecodeError::MissingRoot)?;
    if root.parent_node_id.is_some() {
        return Err(DecodeError::InvalidRoot);
    }

    let mut children = HashMap::<i64, Vec<i64>>::new();
    for row in nodes.values().filter(|row| row.node_id != 0) {
        let parent = row.parent_node_id.ok_or(DecodeError::MissingParent {
            node: row.node_id,
            parent: -1,
        })?;
        if !nodes.contains_key(&parent) {
            return Err(DecodeError::MissingParent {
                node: row.node_id,
                parent,
            });
        }
        children.entry(parent).or_default().push(row.node_id);
    }
    for child_ids in children.values_mut() {
        child_ids.sort_by_key(|id| {
            let row = &nodes[id];
            (row.node_order, row.node_id)
        });
    }

    let mut visited = HashSet::with_capacity(nodes.len());
    let value = build_value(0, 0, &nodes, &children, &mut visited)?;
    if visited.len() != nodes.len() {
        return Err(DecodeError::InvalidGraph);
    }
    Ok(value)
}

fn build_value(
    node_id: i64,
    depth: usize,
    nodes: &HashMap<i64, NodeRow>,
    children: &HashMap<i64, Vec<i64>>,
    visited: &mut HashSet<i64>,
) -> Result<RelationalValue, DecodeError> {
    if depth > MAX_DEPTH {
        return Err(DecodeError::TooDeep);
    }
    if !visited.insert(node_id) {
        return Err(DecodeError::InvalidGraph);
    }
    let row = &nodes[&node_id];
    match row.value_type.as_str() {
        "null" => Ok(RelationalValue::Null),
        "undefined" => Ok(RelationalValue::Undefined),
        "boolean" => Ok(RelationalValue::Boolean(
            row.boolean_value.unwrap_or(0) != 0,
        )),
        "number" => Ok(RelationalValue::Number(match row.text_value.as_deref() {
            Some("NaN") => f64::NAN,
            Some("Infinity") => f64::INFINITY,
            Some("-Infinity") => f64::NEG_INFINITY,
            _ => row.number_value.unwrap_or(0.0),
        })),
        "string" => Ok(RelationalValue::String(decode_text(
            row.text_value.as_deref(),
            row.encoded_text_value.as_deref(),
        )?)),
        "array" => {
            let values = children
                .get(&node_id)
                .into_iter()
                .flatten()
                .map(|child| build_value(*child, depth + 1, nodes, children, visited))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(RelationalValue::Array(values))
        }
        "object" => {
            let entries = children
                .get(&node_id)
                .into_iter()
                .flatten()
                .map(|child| {
                    let child_row = &nodes[child];
                    let key = match (
                        child_row.object_key.as_deref(),
                        child_row.object_key_encoded.as_deref(),
                    ) {
                        (None, None) => return Err(DecodeError::MissingObjectKey(*child)),
                        (text, encoded) => decode_text(text, encoded)?,
                    };
                    let value = build_value(*child, depth + 1, nodes, children, visited)?;
                    Ok((key, value))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(RelationalValue::Object(entries))
        }
        other => Err(DecodeError::UnknownType(other.to_owned())),
    }
}

fn decode_text(text: Option<&str>, encoded: Option<&str>) -> Result<String, DecodeError> {
    let Some(encoded) = encoded else {
        return Ok(text.unwrap_or_default().to_owned());
    };
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| DecodeError::InvalidBase64)?;
    if bytes.len() % 2 != 0 {
        return Err(DecodeError::OddUtf16Length);
    }
    let code_units = bytes
        .chunks_exact(2)
        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&code_units).map_err(|_| DecodeError::InvalidUtf16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, parent: Option<i64>, order: i64, key: Option<&str>, kind: &str) -> NodeRow {
        NodeRow {
            node_id: id,
            parent_node_id: parent,
            node_order: order,
            object_key: key.map(str::to_owned),
            object_key_encoded: None,
            value_type: kind.into(),
            text_value: None,
            encoded_text_value: None,
            number_value: None,
            boolean_value: None,
        }
    }

    #[test]
    fn decodes_nested_objects_arrays_and_special_numbers() {
        let mut name = row(1, Some(0), 0, Some("name"), "string");
        name.text_value = Some("Risu".into());
        let array = row(2, Some(0), 1, Some("values"), "array");
        let mut number = row(3, Some(2), 0, None, "number");
        number.text_value = Some("Infinity".into());
        let mut boolean = row(4, Some(2), 1, None, "boolean");
        boolean.boolean_value = Some(1);

        let decoded = decode_rows(vec![
            row(0, None, 0, None, "object"),
            name,
            array,
            number,
            boolean,
        ])
        .unwrap();
        assert_eq!(
            decoded.get("name").and_then(RelationalValue::as_str),
            Some("Risu")
        );
        let RelationalValue::Array(values) = decoded.get("values").unwrap() else {
            panic!("values should be an array");
        };
        assert!(matches!(values[0], RelationalValue::Number(value) if value.is_infinite()));
        assert_eq!(values[1], RelationalValue::Boolean(true));
    }

    #[test]
    fn decodes_utf16_base64_keys_and_values() {
        let mut value = row(1, Some(0), 0, None, "string");
        value.object_key_encoded = Some(
            BASE64.encode(
                "키"
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes)
                    .collect::<Vec<_>>(),
            ),
        );
        value.encoded_text_value = Some(
            BASE64.encode(
                "값\0"
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes)
                    .collect::<Vec<_>>(),
            ),
        );
        let decoded = decode_rows(vec![row(0, None, 0, None, "object"), value]).unwrap();
        assert_eq!(
            decoded.get("키").and_then(RelationalValue::as_str),
            Some("값\0")
        );
    }

    #[test]
    fn rejects_orphan_and_unreachable_cycles() {
        let orphan = row(1, Some(99), 0, Some("bad"), "string");
        assert!(matches!(
            decode_rows(vec![row(0, None, 0, None, "object"), orphan]),
            Err(DecodeError::MissingParent { .. })
        ));

        let cycle_a = row(1, Some(2), 0, Some("a"), "object");
        let cycle_b = row(2, Some(1), 0, Some("b"), "object");
        assert_eq!(
            decode_rows(vec![row(0, None, 0, None, "object"), cycle_a, cycle_b]),
            Err(DecodeError::InvalidGraph)
        );
    }

    #[test]
    fn json_conversion_preserves_hypa_compatible_nested_values_and_integral_ids() {
        let value = RelationalValue::Object(vec![
            ("lastMainChunkID".into(), RelationalValue::Number(4.0)),
            (
                "chunks".into(),
                RelationalValue::Array(vec![RelationalValue::Object(vec![
                    ("mainChunkID".into(), RelationalValue::Number(4.0)),
                    ("text".into(), RelationalValue::String("event".into())),
                ])]),
            ),
        ]);
        let json = value.to_json_value().unwrap();
        assert_eq!(json["lastMainChunkID"], 4);
        assert_eq!(json["chunks"][0]["mainChunkID"], 4);
        assert!(RelationalValue::Number(f64::NAN).to_json_value().is_none());
    }
}
