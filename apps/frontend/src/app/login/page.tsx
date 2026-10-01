"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, EmailNotVerifiedError } from "@/lib/auth-context";
import { api } from "@/lib/api";
import Link from "next/link";
import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { AuthThemeToggle } from "@/components/auth/AuthThemeToggle";
import { BrandMark } from "@/components/ui/BrandMark";
import { FormStatus } from "@/components/ui/FormStatus";
import { isWebAuthnSupported, loginWithPasskey } from "@/lib/webauthn";
import { openDesktopPasskey } from "@/lib/desktop-bridge";

const SSO_ERROR_MESSAGES: Record<string, string> = {
  sso_not_configured: "SSO is not configured on this server yet.",
  sso_no_email: "That provider didn't return an email we could use.",
  sso_invalid_state: "The sign-in request was invalid - please try again.",
  sso_failed: "Sign-in with that provider failed. Please try again.",
};

function passkeyErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  if (/cancel|abort|not allowed/i.test(msg)) return "Passkey sign-in was cancelled.";
  if (/not supported/i.test(msg)) return "Passkeys are not supported in this browser.";
  return "Passkey sign-in failed. Please try again or use another sign-in method.";
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [ssoError, setSsoError] = useState<keyof typeof SSO_ERROR_MESSAGES | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

  // Where to land after a successful sign-in. `next` is set by pages that bounce
  // an unauthenticated deep link here (e.g. a returning OAuth callback carrying
  // ?code=...), so the destination and its query string are not lost. Only
  // same-site paths are honored (no scheme, no protocol-relative `//`).
  const nextDestination = useCallback((): string => {
    if (typeof window === "undefined") return "/";
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) return next;
    return "/";
  }, []);

  const handlePasskey = useCallback(async (desktopNonce?: string) => {
    setError("");
    setPasskeyLoading(true);
    try {
      const res = await loginWithPasskey(desktopNonce);
      // Desktop: the shell finishes the session through the deep link.
      if (res?.redirect) {
        window.location.href = res.redirect;
        return;
      }
      router.push(nextDestination());
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setPasskeyLoading(false);
    }
  }, [router, nextDestination]);

  const startPasskey = useCallback(async () => {
    // In Electron, hand the ceremony to the system browser (in-window WebAuthn
    // is broken on macOS); the shell returns via the prysmnote:// deep link.
    if (await openDesktopPasskey()) return;
    await handlePasskey();
  }, [handlePasskey]);

  // Read the SSO error (e.g. ?error=sso_failed) client-side only, so this page
  // stays statically prerenderable (avoiding useSearchParams' Suspense need).
  useEffect(() => {
    setPasskeySupported(isWebAuthnSupported());
    const params = new URLSearchParams(window.location.search);
    const e = params.get("error");
    if (e && e in SSO_ERROR_MESSAGES) setSsoError(e as keyof typeof SSO_ERROR_MESSAGES);
    // Desktop shell opens this page with ?passkey=1&redirect=desktop&nonce=...;
    // run the ceremony in this (system) browser, then bounce to the deep link.
    if (params.get("passkey") === "1" && params.get("redirect") === "desktop") {
      const nonce = params.get("nonce") || "";
      if (nonce) void handlePasskey(nonce);
    }
  }, [handlePasskey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNeedsVerification(false);
    setLoading(true);
    try {
      await login(email, password);
      router.push(nextDestination());
    } catch (err) {
      if (err instanceof EmailNotVerifiedError) {
        setNeedsVerification(true);
      } else {
        setError(err instanceof Error ? err.message : "Login failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    setResent(false);
    try {
      await api.post("/auth/resend-verification", { email });
      setResent(true);
    } catch {
      setError("Couldn't resend the verification email. Please try again.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-base p-4">
      <AuthThemeToggle />
      <div className="w-full max-w-sm scale-in">
        <div className="card p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 gradient-bg opacity-60" />
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10">
              <BrandMark size={32} />
            </div>
            <h1 className="text-xl font-bold gradient-text">Welcome back</h1>
            <p className="mt-1 text-sm text-muted">Sign in to Prysm Note</p>
          </div>

          {error && (
            <FormStatus variant="error" className="mb-4">
              {error}
            </FormStatus>
          )}
          {needsVerification && !error && (
            <FormStatus variant="warning" className="mb-4">
              <p className="font-medium">Please verify your email</p>
              <p className="mt-1 text-xs">
                Check {email ? <span className="text-secondary">{email}</span> : "your inbox"} for a
                verification link before signing in.
              </p>
              <button
                type="button"
                onClick={handleResend}
                disabled={resending || resent}
                className="mt-2 text-xs font-medium text-accent hover:text-accent-hover disabled:opacity-50"
              >
                {resent ? "Verification email sent" : resending ? "Sending..." : "Resend verification email"}
              </button>
            </FormStatus>
          )}
          {ssoError && !error && !needsVerification && (
            <FormStatus variant="warning" className="mb-4">
              {SSO_ERROR_MESSAGES[ssoError]}
            </FormStatus>
          )}

          {passkeySupported && (
            <button
              type="button"
              onClick={startPasskey}
              disabled={passkeyLoading}
              className="btn mb-2 flex w-full items-center justify-center gap-2 bg-elevated border border-border py-2.5 text-sm text-primary hover:bg-elevated-hover disabled:opacity-50"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="9" cy="9" r="3.5" />
                <path d="M12 12.5a4.5 4.5 0 1 1-3.2 7.7" />
                <path d="M15 8h5.5M15 11.5h5.5M15 15h3" />
              </svg>
              {passkeyLoading ? "Waiting for passkey..." : "Sign in with a passkey"}
            </button>
          )}

          <OAuthButtons />

          <div className="my-5 flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" />
            or with email
            <span className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-secondary">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="input-field"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-secondary">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="input-field"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary mt-2 w-full py-2.5 text-sm disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-muted">
            <Link href="/forgot-password" className="text-accent hover:text-accent-hover font-medium">
              Forgot your password?
            </Link>
          </p>

          <p className="mt-4 text-center text-xs text-muted">
            Don&apos;t have an account?{" "}
            <Link href="/register" className="text-accent hover:text-accent-hover font-medium">
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}