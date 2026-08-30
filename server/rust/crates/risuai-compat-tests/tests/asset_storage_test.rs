use risuai_assets::fs::LocalFsStorage;
use risuai_assets::manager::AssetStorageManager;
use tempfile::tempdir;

#[tokio::test]
async fn test_local_fs_asset_operations() {
    let dir = tempdir().unwrap();
    let fs_storage = LocalFsStorage::new(dir.path());

    let content = b"Sample noble text asset";
    fs_storage.write("sample.txt", content).await.unwrap();

    assert!(fs_storage.exists("sample.txt").await.unwrap());

    let read_res = fs_storage.read("sample.txt").await.unwrap().unwrap();
    assert_eq!(read_res.data, content);
    assert_eq!(read_res.content_type, "text/plain");

    let list = fs_storage.list("").await.unwrap();
    assert!(list.contains(&"sample.txt".to_string()));

    fs_storage.delete("sample.txt").await.unwrap();
    assert!(!fs_storage.exists("sample.txt").await.unwrap());
}

#[tokio::test]
async fn test_asset_manager_fallback() {
    let dir = tempdir().unwrap();
    let manager = AssetStorageManager::init(dir.path()).await;

    manager
        .write("greeting.json", b"{\"msg\":\"bonjour\"}")
        .await
        .unwrap();
    let read_res = manager.read("greeting.json").await.unwrap().unwrap();
    assert_eq!(read_res.data, b"{\"msg\":\"bonjour\"}");
}
