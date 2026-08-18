"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import { OAuthButtons } from "@/components/auth/OAuthButtons";

const SSO_ERROR_MESSAGES: Record<string, string> = {
  sso_not_configured: "SSO is not configured on this server yet.",
  sso_no_email: "That provider didn't return an email we could use.",
  sso_invalid_state: "The sign-in request was invalid — please try again.",
  sso_failed: "Sign-in with that provider failed. Please try again.",
};

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [ssoError, setSsoError] = useState<keyof typeof SSO_ERROR_MESSAGES | null>(null);
  const [loading, setLoading] = useState(false);
  const [registered, setRegistered] = useState(false);
  const { register } = useAuth();
  const router = useRouter();

  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get("error");
    if (e && e in SSO_ERROR_MESSAGES) setSsoError(e as keyof typeof SSO_ERROR_MESSAGES);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      const result = await register(email, password, displayName || undefined);
      if (result.requiresVerification) {
        setRegistered(true);
      } else {
        router.push("/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  if (registered) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base p-4">
        <div className="w-full max-w-sm scale-in">
          <div className="card p-8 relative overflow-hidden text-center">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent via-purple-400 to-accent opacity-60" />
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
            </div>
            <h1 className="text-xl font-bold gradient-text">Check your inbox</h1>
            <p className="mt-2 text-sm text-muted">
              We sent a verification link to <span className="font-medium text-secondary">{email}</span>.
              Click it to confirm your email — then you can sign in.
            </p>
            <p className="mt-4 text-xs text-muted">
              Didn&apos;t get it? Check spam, or go to the{" "}
              <Link href="/login" className="text-accent hover:text-accent-hover font-medium">
                sign in
              </Link>{" "}
              page to resend.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-base p-4">
      <div className="w-full max-w-sm scale-in">
        <div className="card p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent via-purple-400 to-accent opacity-60" />
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 float">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
            </div>
            <h1 className="text-xl font-bold gradient-text">Create account</h1>
            <p className="mt-1 text-sm text-muted">Get started with Prysm Note</p>
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-danger/10 px-4 py-2.5 text-sm text-danger">
              {error}
            </div>
          )}
          {ssoError && !error && (
            <div className="mb-4 rounded-lg bg-warning/10 px-4 py-2.5 text-sm text-warning">
              {SSO_ERROR_MESSAGES[ssoError]}
            </div>
          )}

          <OAuthButtons />

          <div className="my-5 flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" />
            or sign up with email
            <span className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-secondary">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name (optional)"
                className="input-field"
              />
            </div>
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
                placeholder="At least 8 characters"
                className="input-field"
                required
                minLength={8}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary mt-2 w-full py-2.5 text-sm disabled:opacity-50"
            >
              {loading ? "Creating account..." : "Create Account"}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-muted">
            Already have an account?{" "}
            <Link href="/login" className="text-accent hover:text-accent-hover font-medium">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}