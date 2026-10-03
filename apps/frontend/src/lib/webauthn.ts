"use client";

/**
 * Native WebAuthn passkey helpers (core feature, all users).
 *
 * The browser/PWA runs the platform ceremony through `navigator.credentials`
 * (Touch ID / Face ID / Windows Hello / security key). In the Electron desktop
 * app `navigator.credentials` is unreliable on macOS, so the caller routes the
 * flow to the system browser first (see `openDesktopPasskey`).
 *
 * All server calls go through `@/lib/api` so the CSRF header + 401 refresh are
 * handled automatically. Challenges travel in HttpOnly cookies set by the
 * backend, never in JS.
 */
import { api } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

/**
 * POST a public (unauthenticated) endpoint without the api client's 401-refresh
 * behavior: a failed passkey sign-in is a 401, and the shared client would treat
 * that as an expired session and bounce to /login. These endpoints are
 * CSRF-exempt, so no double-submit header is needed.
 */
async function postPublic<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let message = "Passkey sign-in failed";
    try {
      const data = await res.json();
      if (typeof data?.detail === "string") message = data.detail;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return res.json();
}

/**
 * WebAuthn ceremonies can hang with no prompt at all when the platform has no
 * usable authenticator (for example the Electron desktop app before native
 * WebAuthn is enabled). Bound the wait so the caller surfaces a clear error
 * instead of spinning on "Waiting for device..." until the browser gives up.
 */
const CEREMONY_TIMEOUT_MS = 60_000;

async function withCeremonyTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), CEREMONY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PasskeySummary {
  id: string;
  name: string | null;
  created_at: string | null;
  last_used_at: string | null;
  aaguid: string | null;
  transports: string | null;
}

interface JsonCredentialDescriptor {
  id: string;
  type: string;
  transports?: string[];
}

interface CreationOptionsJson {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: JsonCredentialDescriptor[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

interface RequestOptionsJson {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: JsonCredentialDescriptor[];
  userVerification?: UserVerificationRequirement;
}

/**
 * The backend serializes webauthn-rs `CreationChallengeResponse` /
 * `RequestChallengeResponse`, which wrap the browser options under a
 * `publicKey` key. Unwrap that before handing options to `navigator.credentials`.
 */
interface CreationChallengeResponse {
  publicKey: CreationOptionsJson;
}

interface RequestChallengeResponse {
  publicKey: RequestOptionsJson;
  mediation?: string;
}

export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined"
  );
}

export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64url(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCreationOptions(options: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    rp: options.rp as PublicKeyCredentialRpEntity,
    user: {
      id: base64urlToBytes(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    challenge: base64urlToBytes(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout,
    excludeCredentials: options.excludeCredentials?.map((c) => ({
      id: base64urlToBytes(c.id),
      type: c.type as PublicKeyCredentialType,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    authenticatorSelection: options.authenticatorSelection,
    attestation: options.attestation,
  };
}

function decodeRequestOptions(options: RequestOptionsJson): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64urlToBytes(options.challenge),
    timeout: options.timeout,
    rpId: options.rpId,
    allowCredentials: options.allowCredentials?.map((c) => ({
      id: base64urlToBytes(c.id),
      type: c.type as PublicKeyCredentialType,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    userVerification: options.userVerification,
  };
}

function serializeRegistration(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      attestationObject: bytesToBase64url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

function serializeAssertion(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      authenticatorData: bytesToBase64url(response.authenticatorData),
      signature: bytesToBase64url(response.signature),
      userHandle: response.userHandle ? bytesToBase64url(response.userHandle) : null,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

/** Register a new passkey for the signed-in user. Returns the created row. */
export async function registerPasskey(name?: string): Promise<PasskeySummary> {
  if (!isWebAuthnSupported()) throw new Error("Passkeys are not supported in this browser.");
  const response = await api.post<CreationChallengeResponse>("/auth/passkey/register/options");
  const credential = (await withCeremonyTimeout(
    navigator.credentials.create({
      publicKey: decodeCreationOptions(response.publicKey),
    }) as Promise<Credential | null>,
    "No passkey prompt appeared. Update the desktop app or use a browser with Touch ID, Windows Hello or a security key.",
  )) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey registration was cancelled.");
  return api.post<PasskeySummary>("/auth/passkey/register/verify", {
    credential: serializeRegistration(credential),
    name: name?.trim() || undefined,
  });
}

/**
 * Sign in with a passkey. When `desktopNonce` is provided (desktop shell), the
 * response carries a one-time deep-link `redirect` instead of a session, which
 * the caller must navigate to.
 */
export async function loginWithPasskey(
  desktopNonce?: string
): Promise<{ redirect?: string } & Record<string, unknown>> {
  if (!isWebAuthnSupported()) throw new Error("Passkeys are not supported in this browser.");
  const response = await postPublic<RequestChallengeResponse>("/auth/passkey/login/options", {});
  const credential = (await withCeremonyTimeout(
    navigator.credentials.get({
      publicKey: decodeRequestOptions(response.publicKey),
    }) as Promise<Credential | null>,
    "No passkey prompt appeared. Update the desktop app or use a browser with Touch ID, Windows Hello or a security key.",
  )) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey sign-in was cancelled.");
  return postPublic("/auth/passkey/login/verify", {
    credential: serializeAssertion(credential),
    desktop_nonce: desktopNonce,
  });
}

export const passkeysApi = {
  list: () => api.get<PasskeySummary[]>("/auth/passkey"),
  rename: (id: string, name: string) => api.patch<{ id: string; name: string }>(`/auth/passkey/${id}`, { name }),
  remove: (id: string) => api.delete<void>(`/auth/passkey/${id}`),
};
