//! Web Push sender (RFC 8291 aes128gcm + VAPID), ported from
//! `apps/backend/app/services/push_service.py`.
//!
//! Builds the payload with ECDH + HKDF-derived AES-128-GCM (RFC 8291) using the
//! subscription's `p256dh` and `auth` secrets, and signs a VAPID ES256 JWT with
//! the configured PEM private key. Only the openssl crate is used, mirroring the
//! Python implementation's reliance on `cryptography` (no extra Web Push crate).
//!
//! The wire format is replicated byte-for-byte, including the Python key-id
//! length quirk of writing `len(ecdh_public) + 1` while appending the 65-byte
//! uncompressed point itself.

use std::time::Duration;

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use openssl::bn::BigNumContext;
use openssl::derive::Deriver;
use openssl::ec::{EcGroup, EcKey, EcPoint, PointConversionForm};
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::{PKey, Private};
use openssl::sign::Signer;
use openssl::symm::{Cipher, Crypter, Mode};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::Settings;

/// Push record size declared in the aes128gcm header (RFC 8188).
pub const HEADER_RS: u32 = 4096;

/// VAPID JWT audience (all major push services accept the FCM audience).
const VAPID_AUDIENCE: &str = "https://fcm.googleapis.com";

/// Outcome of a push send, mirroring the Python string return.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushResult {
    /// Accepted by the push service (HTTP 200/201/202).
    Sent,
    /// Subscription is gone (HTTP 404/410); the caller should delete it.
    Stale,
    /// Any other status, missing configuration, or transport error.
    Error,
}

impl PushResult {
    /// The Python-compatible string form.
    pub fn as_str(&self) -> &'static str {
        match self {
            PushResult::Sent => "sent",
            PushResult::Stale => "stale",
            PushResult::Error => "error",
        }
    }
}

fn b64url_encode(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

fn b64url_decode(value: &str) -> Result<Vec<u8>, String> {
    let mut padded = value.to_string();
    let rem = padded.len() % 4;
    if rem != 0 {
        padded.push_str(&"=".repeat(4 - rem));
    }
    URL_SAFE.decode(padded.as_bytes()).map_err(|err| err.to_string())
}

/// RFC 2104 HMAC-SHA256, used to build HKDF (no extra crypto dependency).
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key_block = [0u8; BLOCK];
    if key.len() > BLOCK {
        let mut hasher = Sha256::new();
        hasher.update(key);
        key_block[..32].copy_from_slice(&hasher.finalize());
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    let out = outer.finalize();

    let mut result = [0u8; 32];
    result.copy_from_slice(&out);
    result
}

/// RFC 5869 HKDF-SHA256 (`salt` is the extract salt, `ikm` the key material).
fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], length: usize) -> Vec<u8> {
    let prk = hmac_sha256(salt, ikm);
    let mut okm: Vec<u8> = Vec::with_capacity(length);
    let mut block: Vec<u8> = Vec::new();
    let mut counter: u8 = 1;
    while okm.len() < length {
        let mut input = Vec::with_capacity(block.len() + info.len() + 1);
        input.extend_from_slice(&block);
        input.extend_from_slice(info);
        input.push(counter);
        block = hmac_sha256(&prk, &input).to_vec();
        okm.extend_from_slice(&block);
        counter = counter.wrapping_add(1);
    }
    okm.truncate(length);
    okm
}

fn p256_group() -> Result<EcGroup, String> {
    EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).map_err(|err| err.to_string())
}

/// Generate a P-256 keypair; returns the private key and the uncompressed
/// public point (`0x04 || x || y`).
fn ecdh_keypair() -> Result<(PKey<Private>, Vec<u8>), String> {
    let group = p256_group()?;
    let key = EcKey::generate(&group).map_err(|err| err.to_string())?;
    let mut ctx = BigNumContext::new().map_err(|err| err.to_string())?;
    let public = key
        .public_key()
        .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
        .map_err(|err| err.to_string())?;
    let pkey = PKey::from_ec_key(key).map_err(|err| err.to_string())?;
    Ok((pkey, public))
}

fn random_salt() -> Result<[u8; 16], String> {
    let mut salt = [0u8; 16];
    openssl::rand::rand_bytes(&mut salt).map_err(|err| err.to_string())?;
    Ok(salt)
}

fn aes128gcm_encrypt(key: &[u8], nonce: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Cipher::aes_128_gcm();
    let mut crypter =
        Crypter::new(cipher, Mode::Encrypt, key, Some(nonce)).map_err(|err| err.to_string())?;
    crypter.aad_update(b"").map_err(|err| err.to_string())?;
    let mut out = vec![0u8; plaintext.len() + cipher.block_size() + 16];
    let count = crypter
        .update(plaintext, &mut out)
        .map_err(|err| err.to_string())?;
    let rest = crypter
        .finalize(&mut out[count..])
        .map_err(|err| err.to_string())?;
    out.truncate(count + rest);
    // GCM tag is not appended by finalize; retrieve it explicitly and append.
    let mut tag = [0u8; 16];
    crypter.get_tag(&mut tag).map_err(|err| err.to_string())?;
    out.extend_from_slice(&tag);
    Ok(out)
}

/// Encrypt a payload for a subscription (`p256dh`/`auth` are b64url strings).
fn encrypt_payload(plaintext: &[u8], p256dh: &str, auth: &str) -> Result<Vec<u8>, String> {
    let salt = random_salt()?;

    let group = p256_group()?;
    let mut ctx = BigNumContext::new().map_err(|err| err.to_string())?;
    let peer_bytes = b64url_decode(p256dh)?;
    let peer_point =
        EcPoint::from_bytes(&group, &peer_bytes, &mut ctx).map_err(|err| err.to_string())?;
    let peer_ec = EcKey::from_public_key(&group, &peer_point).map_err(|err| err.to_string())?;
    let peer_pkey = PKey::from_ec_key(peer_ec).map_err(|err| err.to_string())?;

    let (ecdh_private, ecdh_public) = ecdh_keypair()?;
    let mut deriver = Deriver::new(&ecdh_private).map_err(|err| err.to_string())?;
    deriver.set_peer(&peer_pkey).map_err(|err| err.to_string())?;
    let ecdh_secret = deriver.derive_to_vec().map_err(|err| err.to_string())?;

    let auth_secret = b64url_decode(auth)?;

    let prk = hkdf_sha256(&auth_secret, &salt, b"Content-Encoding: auth\x00", 32);
    let cek = hkdf_sha256(&prk, &ecdh_secret, b"Content-Encoding: aes128gcm\x00", 16);
    let nonce = hkdf_sha256(&prk, &ecdh_secret, b"Content-Encoding: nonce\x00", 12);

    let mut padded = plaintext.to_vec();
    padded.push(0x02);
    let ciphertext = aes128gcm_encrypt(&cek, &nonce, &padded)?;

    let mut out = Vec::with_capacity(16 + 4 + 1 + ecdh_public.len() + ciphertext.len());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&HEADER_RS.to_be_bytes());
    out.push((ecdh_public.len() + 1) as u8);
    out.extend_from_slice(&ecdh_public);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Load the VAPID PEM private key and return its uncompressed public point.
fn vapid_public_bytes(settings: &Settings) -> Result<Vec<u8>, String> {
    let pkey = PKey::private_key_from_pem(settings.vapid_private_key.as_bytes())
        .map_err(|err| err.to_string())?;
    let ec = pkey.ec_key().map_err(|err| err.to_string())?;
    let group = p256_group()?;
    let mut ctx = BigNumContext::new().map_err(|err| err.to_string())?;
    ec.public_key()
        .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
        .map_err(|err| err.to_string())
}

/// Build and sign the VAPID ES256 JWT. The JSON bodies match Python's
/// `json.dumps` spacing so the signed bytes are identical.
fn sign_vapid_jwt(settings: &Settings) -> Result<String, String> {
    let header = b64url_encode(br#"{"typ": "JWT", "alg": "ES256"}"#);
    let now = chrono::Utc::now().timestamp();
    let subject = serde_json::to_string(&settings.vapid_subject).map_err(|err| err.to_string())?;
    let claims_json = format!(
        r#"{{"aud": "{VAPID_AUDIENCE}", "exp": {}, "sub": {subject}}}"#,
        now + 12 * 3600
    );
    let claims = b64url_encode(claims_json.as_bytes());
    let signing_input = format!("{header}.{claims}");

    let pkey = PKey::private_key_from_pem(settings.vapid_private_key.as_bytes())
        .map_err(|err| err.to_string())?;
    let mut signer =
        Signer::new(MessageDigest::sha256(), &pkey).map_err(|err| err.to_string())?;
    signer
        .update(signing_input.as_bytes())
        .map_err(|err| err.to_string())?;
    let signature = signer.sign_to_vec().map_err(|err| err.to_string())?;

    Ok(format!("{header}.{claims}.{}", b64url_encode(&signature)))
}

/// Send a Web Push message. Returns `Sent`, `Stale` (dead subscription, delete
/// it) or `Error`, never propagating a transport failure.
pub async fn send_push(
    settings: &Settings,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    payload: &Value,
) -> PushResult {
    if settings.vapid_private_key.is_empty() || settings.vapid_public_key().is_empty() {
        return PushResult::Error;
    }

    let attempt: Result<u16, String> = async {
        let body = encrypt_payload(payload.to_string().as_bytes(), p256dh, auth)?;
        let jwt = sign_vapid_jwt(settings)?;
        let public = vapid_public_bytes(settings)?;
        let authorization = format!("vapid t={jwt}, k={}", b64url_encode(&public));

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|err| err.to_string())?;
        let response = client
            .post(endpoint)
            .header("Authorization", authorization)
            .header("Content-Encoding", "aes128gcm")
            .header("TTL", "86400")
            .header("Content-Type", "application/octet-stream")
            .body(body)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        Ok(response.status().as_u16())
    }
    .await;

    match attempt {
        Ok(200) | Ok(201) | Ok(202) => PushResult::Sent,
        Ok(404) | Ok(410) => PushResult::Stale,
        _ => PushResult::Error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;

    fn test_settings_with_key() -> (Settings, String) {
        let group = p256_group().unwrap();
        let key = EcKey::generate(&group).unwrap();
        let pem = String::from_utf8(key.private_key_to_pem().unwrap()).unwrap();
        let mut settings = config::tests::sample("test");
        settings.vapid_private_key = pem.clone();
        (settings, pem)
    }

    #[test]
    fn b64url_round_trip_and_no_padding() {
        let data = vec![0xfb, 0xff, 0x00, 0x01, 0x02];
        let encoded = b64url_encode(&data);
        assert!(!encoded.contains('='), "encoding must be unpadded");
        assert!(!encoded.contains('+') && !encoded.contains('/'));
        assert_eq!(b64url_decode(&encoded).unwrap(), data);

        // Python pads before decoding; a padded input must decode identically.
        let rem = encoded.len() % 4;
        if rem != 0 {
            let padded = format!("{encoded}{}", "=".repeat(4 - rem));
            assert_eq!(b64url_decode(&padded).unwrap(), data);
        }
    }

    #[test]
    fn hmac_sha256_matches_rfc4231_case_1() {
        let key = [0x0bu8; 20];
        let expected = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";
        let digest = hmac_sha256(&key, b"Hi There");
        assert_eq!(hex(&digest), expected);
    }

    #[test]
    fn hkdf_sha256_matches_rfc5869_case_1() {
        let ikm = [0x0bu8; 22];
        let salt: Vec<u8> = (0u8..=12).collect();
        let info: Vec<u8> = (0xf0u8..=0xf9).collect();
        let okm = hkdf_sha256(&ikm, &salt, &info, 42);
        let expected = concat!(
            "3cb25f25faacd57a90434f64d0362f2a",
            "2d2d0a90cf1a5a4c5db02d56ecc4c5bf",
            "34007208d5b887185865"
        );
        assert_eq!(hex(&okm), expected);
        assert_eq!(hkdf_sha256(b"a", b"b", b"c", 16).len(), 16);
        assert_eq!(hkdf_sha256(b"a", b"b", b"c", 32).len(), 32);
    }

    #[test]
    fn aes128gcm_header_layout_matches_python() {
        // A peer P-256 keypair supplies p256dh; auth is a random 16-byte secret.
        let group = p256_group().unwrap();
        let peer = EcKey::generate(&group).unwrap();
        let mut ctx = BigNumContext::new().unwrap();
        let peer_pub = peer
            .public_key()
            .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
            .unwrap();
        let p256dh = b64url_encode(&peer_pub);
        let auth = b64url_encode(&[0x42u8; 16]);

        let plaintext = b"hello";
        let out = encrypt_payload(plaintext, &p256dh, &auth).unwrap();

        // salt(16) + rs(4) + keyid_len(1) + ecdh_public(65) + ciphertext(pt+1+16)
        assert_eq!(out.len(), 16 + 4 + 1 + 65 + plaintext.len() + 1 + 16);
        assert_eq!(&out[16..20], &HEADER_RS.to_be_bytes());
        assert_eq!(out[20], 66, "Python writes len(ecdh_public) + 1");
        assert_eq!(out[21], 0x04, "uncompressed point marker");
        assert_eq!(&out[21..86].len(), &65usize);
    }

    #[test]
    fn vapid_jwt_has_three_segments_and_signed_claims() {
        let (settings, _) = test_settings_with_key();
        let jwt = sign_vapid_jwt(&settings).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT must be header.claims.signature");
        assert!(!parts[0].is_empty() && !parts[1].is_empty() && !parts[2].is_empty());

        let header = String::from_utf8(b64url_decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header, r#"{"typ": "JWT", "alg": "ES256"}"#);
        let claims = String::from_utf8(b64url_decode(parts[1]).unwrap()).unwrap();
        assert!(claims.contains(r#""aud": "https://fcm.googleapis.com""#));
        assert!(claims.contains(r#""sub": "mailto:support@prysmnote.com""#));
    }

    #[test]
    fn vapid_public_bytes_are_uncompressed_p256_point() {
        let (settings, _) = test_settings_with_key();
        let bytes = vapid_public_bytes(&settings).unwrap();
        assert_eq!(bytes.len(), 65);
        assert_eq!(bytes[0], 0x04);
    }

    #[tokio::test]
    async fn send_push_without_keys_returns_error() {
        let settings = config::tests::sample("test");
        let outcome = send_push(
            &settings,
            "https://fcm.googleapis.com/fcm/send/x",
            "k",
            "a",
            &serde_json::json!({"title": "t", "body": "b"}),
        )
        .await;
        assert_eq!(outcome, PushResult::Error);
        assert_eq!(outcome.as_str(), "error");
    }

    fn hex(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }
}
