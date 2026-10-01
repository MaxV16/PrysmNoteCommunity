from cryptography.fernet import Fernet

from app.config import settings


def get_cipher() -> Fernet:
    key = settings.encryption_key
    if len(key) != 44:
        raise ValueError(
            f"ENCRYPTION_KEY must be a 44-character Fernet key (got {len(key)} chars)"
        )
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt_api_key(api_key: str) -> bytes:
    cipher = get_cipher()
    return cipher.encrypt(api_key.encode())


def decrypt_api_key(encrypted_key: bytes) -> str:
    cipher = get_cipher()
    return cipher.decrypt(encrypted_key).decode()


def decrypt_stored_token(stored: bytes | str) -> str:
    """Decrypt a credential written by the EE integration store helpers.

    Those helpers persist the Fernet ciphertext HEX-encoded (``encrypt_api_key(v).hex()``)
    in the ``user_tokens.access_token`` column, so the read path must decode the hex
    back to the raw ciphertext before decrypting. Passing the hex string straight to
    Fernet raises ``InvalidToken``, which callers swallow into "not connected", so
    every stored credential looked unreadable and the Connect button never went away.
    Values that are not valid hex are passed through unchanged for legacy rows.
    """
    if isinstance(stored, str):
        try:
            stored = bytes.fromhex(stored)
        except ValueError:
            stored = stored.encode()
    return decrypt_api_key(stored)

