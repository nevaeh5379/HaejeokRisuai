use crate::api::client::{ApiClient, Result};
use crate::models::character::{CharacterDetail, CharacterSummary};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
struct CharacterSearchResponse {
    #[serde(default)]
    characters: Vec<CharacterSummary>,
}

impl ApiClient {
    /// Calls GET `/api/database-v2/characters/search?q=...`
    /// Backend filters by query and returns a fixed limit of 50 characters: `{"characters": [{"id": "...", "name": "..."}]}`.
    pub async fn search_characters(&self, query: &str) -> Result<Vec<CharacterSummary>> {
        let path = if query.trim().is_empty() {
            "/api/database-v2/characters/search".to_string()
        } else {
            format!(
                "/api/database-v2/characters/search?q={}",
                urlencoding::encode(query.trim())
            )
        };

        let resp: CharacterSearchResponse = self.get(&path).await?;
        Ok(resp.characters)
    }

    /// Calls GET `/api/database-v2/characters/{characterId}`
    /// Returns stored raw character JSON deserialized into `CharacterDetail`.
    pub async fn get_character(&self, character_id: &str) -> Result<CharacterDetail> {
        let path = format!(
            "/api/database-v2/characters/{}",
            urlencoding::encode(character_id)
        );
        self.get(&path).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_character_search_response_envelope_serde() {
        let json_str = r#"{
            "characters": [
                {"id": "char_1", "name": "Character One"},
                {"id": "char_2", "name": "Character Two"}
            ]
        }"#;
        let resp: CharacterSearchResponse =
            serde_json::from_str(json_str).expect("should deserialize CharacterSearchResponse");
        assert_eq!(resp.characters.len(), 2);
        assert_eq!(resp.characters[0].id, "char_1");
        assert_eq!(resp.characters[0].name, "Character One");
        assert_eq!(resp.characters[1].id, "char_2");
        assert_eq!(resp.characters[1].name, "Character Two");
    }
}
