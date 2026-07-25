let cryptoKey: CryptoKey | null = null;

function getStorageKey(): string {
  return "prysm_crypto_key";
}

async function getOrCreateKey(): Promise<CryptoKey> {
  if (cryptoKey) return cryptoKey;

  const stored = sessionStorage.getItem(getStorageKey());
  if (stored) {
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    return cryptoKey;
  }

  cryptoKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const exported = await crypto.subtle.exportKey("raw", cryptoKey);
  sessionStorage.setItem(getStorageKey(), btoa(String.fromCharCode(...new Uint8Array(exported))));
  return cryptoKey;
}

export async function encryptString(plaintext: string): Promise<string> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptString(ciphertext: string): Promise<string | null> {
  try {
    const key = await getOrCreateKey();
    const combined = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

export function clearCryptoKey(): void {
  cryptoKey = null;
  sessionStorage.removeItem(getStorageKey());
}
