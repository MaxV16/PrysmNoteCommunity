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
