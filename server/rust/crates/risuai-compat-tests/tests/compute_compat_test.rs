use risuai_core::chat_executor::{plan_continuation, ChatContinuationRequest};
use risuai_core::tokenize::count_tokens;
use risuai_core::vector::{VectorIndexManager, VectorItem};

#[test]
fn test_tokenize_cl100k() {
    let count = count_tokens("Hello world! RisuAI is noble.", Some("cl100k_base"));
    assert!(count > 0);
}

#[test]
fn test_chat_continuation() {
    let req_incomplete = ChatContinuationRequest {
        result: "The noble lady said that".to_string(),
        minimum_tokens: Some(0),
        used_continue_tokens: Some(0),
        continue_incomplete: Some(true),
        encoding: None,
    };
    let res1 = plan_continuation(&req_incomplete);
    assert!(res1.should_continue);

    let req_complete = ChatContinuationRequest {
        result: "The noble lady smiled elegantly.".to_string(),
        minimum_tokens: Some(0),
        used_continue_tokens: Some(0),
        continue_incomplete: Some(true),
        encoding: None,
    };
    let res2 = plan_continuation(&req_complete);
    assert!(!res2.should_continue);
}

#[tokio::test]
async fn test_vector_index_search() {
    let vm = VectorIndexManager::new(None);

    let items = vec![
        VectorItem {
            id: "doc1".to_string(),
            signature: "sig1".to_string(),
            embedding: vec![1.0, 0.0, 0.0],
        },
        VectorItem {
            id: "doc2".to_string(),
            signature: "sig2".to_string(),
            embedding: vec![0.0, 1.0, 0.0],
        },
    ];

    vm.upsert("idx1", "rev1", 3, items).await;

    let search_res = vm
        .search("idx1", &[1.0, 0.1, 0.0], 5, Some("cosine"), Some(0.5))
        .await;
    assert!(!search_res.is_empty());
    assert_eq!(search_res[0].id, "doc1");
}
