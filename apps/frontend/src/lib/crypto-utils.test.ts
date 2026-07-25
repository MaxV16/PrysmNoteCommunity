import { describe, it, expect } from "vitest";
import { encryptString, decryptString, clearCryptoKey } from "./crypto-utils";

describe("crypto-utils", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    clearCryptoKey();
  });

  it("encrypts and decrypts a string", async () => {
    const original = "sk-proj-test-key-12345";
    const encrypted = await encryptString(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted).not.toContain(original);

    const decrypted = await decryptString(encrypted);
    expect(decrypted).toBe(original);
  });

  it("returns null for invalid ciphertext", async () => {
    const result = await decryptString("invalid-base64!!!");
    expect(result).toBeNull();
  });

  it("produces different ciphertexts for same plaintext", async () => {
    const plaintext = "test-key";
    const a = await encryptString(plaintext);
    const b = await encryptString(plaintext);
    expect(a).not.toBe(b);
  });

  it("stores key in sessionStorage", async () => {
    await encryptString("test");
    const keyRaw = sessionStorage.getItem("prysm_crypto_key");
    expect(keyRaw).toBeTruthy();
  });
});
