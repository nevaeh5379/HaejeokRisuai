use base64::prelude::*;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use risuai_core::auth::AuthState;
use tempfile::tempdir;

#[tokio::test]
async fn test_password_auth_flow() {
    let dir = tempdir().unwrap();
    let auth = AuthState::init(dir.path()).await.unwrap();

    assert!(!auth.is_password_set().await);

    auth.set_password("noble_password_123").await.unwrap();
    assert!(auth.is_password_set().await);
    assert!(auth.check_password("noble_password_123").await);
    assert!(!auth.check_password("wrong_password").await);

    // Re-setting password should fail
    assert!(auth.set_password("another").await.is_err());
}

#[tokio::test]
async fn test_ecdsa_jwt_verification() {
    let dir = tempdir().unwrap();
    let auth = AuthState::init(dir.path()).await.unwrap();

    // Generate random P-256 key
    let signing_key = SigningKey::random(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let point = verifying_key.to_encoded_point(false);

    let x_b64 = BASE64_URL_SAFE_NO_PAD.encode(point.x().unwrap());
    let y_b64 = BASE64_URL_SAFE_NO_PAD.encode(point.y().unwrap());

    let jwk = serde_json::json!({
        "kty": "EC",
        "crv": "P-256",
        "x": x_b64,
        "y": y_b64,
    });

    let pub_hash = auth.add_known_key(&jwk).await.unwrap();

    let header_json = serde_json::json!({ "alg": "ES256", "typ": "JWT" });
    let header_b64 = BASE64_URL_SAFE_NO_PAD.encode(header_json.to_string());

    let exp = chrono::Utc::now().timestamp() + 3600;
    let payload_json = serde_json::json!({
        "exp": exp,
        "pub": jwk
    });
    let payload_b64 = BASE64_URL_SAFE_NO_PAD.encode(payload_json.to_string());

    let signed_content = format!("{}.{}", header_b64, payload_b64);
    let signature: p256::ecdsa::Signature = signing_key.sign(signed_content.as_bytes());
    let sig_b64 = BASE64_URL_SAFE_NO_PAD.encode(signature.to_bytes());

    let token = format!("{}.{}.{}", header_b64, payload_b64, sig_b64);

    let verified_hash = auth.verify_token(&token).await.unwrap();
    assert_eq!(verified_hash, pub_hash);
}
