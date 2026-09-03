"""Web Push sender (RFC 8291 aes128gcm + VAPID) built on the already-installed
``cryptography`` and ``httpx`` libraries - no new third-party dependency.

- VAPID: ES256 JWT signed with the configured private key.
- Payload: ECDH + HKDF-derived AES-128-GCM encryption (RFC 8291) using the
  subscription's ``p256dh`` and ``auth`` secrets.
"""

import base64
import json
import os
import time

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.config import settings

_HEADER_RS = 4096


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _sign_vapid_jwt() -> str:
    header = _b64url_encode(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    now = int(time.time())
    claims = _b64url_encode(
        json.dumps({"aud": "https://fcm.googleapis.com", "exp": now + 12 * 3600, "sub": settings.vapid_subject}).encode()
    )
    signing_input = f"{header}.{claims}".encode()
    key = serialization.load_pem_private_key(settings.vapid_private_key.encode(), password=None)
    signature = key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    return f"{header}.{claims}.{_b64url_encode(signature)}"


def _ecdh_keypair():
    private_key = ec.generate_private_key(ec.SECP256R1())
    numbers = private_key.public_key().public_numbers()
    public_bytes = b"\x04" + numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big")
    return private_key, public_bytes


def _encrypt_payload(plaintext: bytes, p256dh: str, auth: str) -> bytes:
    salt = os.urandom(16)
    peer_point = _b64url_decode(p256dh)
    peer_public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), peer_point)
    ecdh_key, ecdh_public = _ecdh_keypair()
    ecdh_secret = ecdh_key.exchange(ec.ECDH(), peer_public)

    auth_secret = _b64url_decode(auth)

    def _hkdf(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
        return HKDF(
            algorithm=hashes.SHA256(),
            length=length,
            salt=salt,
            info=info,
        ).derive(ikm)

    prk = _hkdf(auth_secret, salt, b"Content-Encoding: auth\x00", 32)
    cek = _hkdf(prk, ecdh_secret, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(prk, ecdh_secret, b"Content-Encoding: nonce\x00", 12)

    padded = plaintext + b"\x02" + b"\x00" * 0
    ciphertext = AESGCM(cek).encrypt(nonce, padded, b"")

    rs = _HEADER_RS.to_bytes(4, "big")
    header = salt + rs + bytes([len(ecdh_public) + 1]) + ecdh_public
    return header + ciphertext


def _vapid_public_bytes() -> bytes:
    key = serialization.load_pem_private_key(settings.vapid_private_key.encode(), password=None)
    numbers = key.public_key().public_numbers()
    return b"\x04" + numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big")


def send_push(endpoint: str, p256dh: str, auth: str, payload: dict) -> str:
    """Send a push notification. Returns 'sent', 'stale' (subscription dead -
    caller should delete it) or 'error'."""
    if not settings.vapid_private_key or not settings.vapid_public_key:
        return "error"
    try:
        body = _encrypt_payload(json.dumps(payload).encode(), p256dh, auth)
        jwt = _sign_vapid_jwt()
        headers = {
            "Authorization": f"vapid t={jwt}, k={_b64url_encode(_vapid_public_bytes())}",
            "Content-Encoding": "aes128gcm",
            "TTL": "86400",
            "Content-Type": "application/octet-stream",
        }
        resp = httpx.post(endpoint, content=body, headers=headers, timeout=15)
        if resp.status_code in (200, 201, 202):
            return "sent"
        if resp.status_code in (404, 410):
            return "stale"
        return "error"
    except Exception:
        return "error"
