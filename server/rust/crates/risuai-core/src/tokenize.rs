use std::sync::OnceLock;
use tiktoken_rs::{cl100k_base, p50k_base, r50k_base, CoreBPE};

static CL100K: OnceLock<CoreBPE> = OnceLock::new();
static P50K: OnceLock<CoreBPE> = OnceLock::new();
static R50K: OnceLock<CoreBPE> = OnceLock::new();

fn get_bpe(encoding_name: &str) -> Option<&'static CoreBPE> {
    match encoding_name.to_lowercase().as_str() {
        "cl100k_base"
        | "cl100k"
        | "gpt-4"
        | "gpt-3.5-turbo"
        | "text-embedding-ada-002"
        | "text-embedding-3-small"
        | "text-embedding-3-large" => Some(CL100K.get_or_init(|| cl100k_base().unwrap())),
        "p50k_base" | "p50k" | "text-davinci-003" | "code-davinci-002" => {
            Some(P50K.get_or_init(|| p50k_base().unwrap()))
        }
        "r50k_base" | "r50k" | "davinci" | "gpt2" => {
            Some(R50K.get_or_init(|| r50k_base().unwrap()))
        }
        _ => None,
    }
}

pub fn count_tokens(text: &str, encoding: Option<&str>) -> usize {
    let enc_name = encoding.unwrap_or("cl100k_base");
    if let Some(bpe) = get_bpe(enc_name) {
        bpe.encode_with_special_tokens(text).len()
    } else {
        let bpe = CL100K.get_or_init(|| cl100k_base().unwrap());
        bpe.encode_with_special_tokens(text).len()
    }
}

pub fn count_tokens_batch(texts: &[impl AsRef<str>], encoding: Option<&str>) -> Vec<usize> {
    texts
        .iter()
        .map(|t| count_tokens(t.as_ref(), encoding))
        .collect()
}
