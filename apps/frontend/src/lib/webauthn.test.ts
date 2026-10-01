import { describe, it, expect, afterEach } from "vitest";
import { base64urlToBytes, bytesToBase64url, isWebAuthnSupported } from "./webauthn";

describe("webauthn base64url helpers", () => {
  it("round-trips arbitrary bytes without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = bytesToBase64url(bytes.buffer);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(Array.from(base64urlToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it("decodes a known vector", () => {
    // "AQID" is base64url for bytes [1, 2, 3].
    expect(Array.from(base64urlToBytes("AQID"))).toEqual([1, 2, 3]);
    expect(bytesToBase64url(new Uint8Array([1, 2, 3]).buffer)).toBe("AQID");
  });

  it("tolerates padded input", () => {
    expect(Array.from(base64urlToBytes("AQID"))).toEqual([1, 2, 3]);
  });
});

describe("isWebAuthnSupported", () => {
  const originalCredentials = navigator.credentials;
  const originalPkc = (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential;

  afterEach(() => {
    Object.defineProperty(navigator, "credentials", {
      value: originalCredentials,
      configurable: true,
    });
    Object.defineProperty(window, "PublicKeyCredential", {
      value: originalPkc,
      configurable: true,
    });
  });

  it("returns false when the platform has no WebAuthn API", () => {
    Object.defineProperty(navigator, "credentials", { value: undefined, configurable: true });
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
    expect(isWebAuthnSupported()).toBe(false);
  });

  it("returns true when navigator.credentials and PublicKeyCredential exist", () => {
    Object.defineProperty(navigator, "credentials", { value: {}, configurable: true });
    Object.defineProperty(window, "PublicKeyCredential", { value: function () {}, configurable: true });
    expect(isWebAuthnSupported()).toBe(true);
  });
});
