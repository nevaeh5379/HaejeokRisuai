/// Truncates a string to at most `max_chars` Unicode characters,
/// appending a single ellipsis ('…' / U+2026) if truncated.
/// Empty input remains empty.
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.is_empty() {
        return String::new();
    }

    let mut chars = text.chars();
    let prefix: String = chars.by_ref().take(max_chars).collect();

    if chars.next().is_none() {
        text.to_string()
    } else {
        format!("{prefix}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ascii_shorter() {
        assert_eq!(truncate_chars("hello", 10), "hello");
    }

    #[test]
    fn test_ascii_exact() {
        assert_eq!(truncate_chars("hello", 5), "hello");
    }

    #[test]
    fn test_ascii_truncated() {
        assert_eq!(truncate_chars("hello world", 5), "hello…");
    }

    #[test]
    fn test_unicode_truncation() {
        assert_eq!(truncate_chars("안녕하세요 세상", 5), "안녕하세요…");
        assert_eq!(truncate_chars("🦀🦀🦀🦀", 2), "🦀🦀…");
        assert_eq!(truncate_chars("감사합니다", 5), "감사합니다");
    }

    #[test]
    fn test_max_zero_empty() {
        assert_eq!(truncate_chars("", 0), "");
    }

    #[test]
    fn test_max_zero_nonempty() {
        assert_eq!(truncate_chars("nonempty", 0), "…");
        assert_eq!(truncate_chars("가", 0), "…");
    }
}
