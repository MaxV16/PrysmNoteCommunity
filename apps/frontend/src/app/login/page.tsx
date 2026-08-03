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

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [ssoError, setSsoError] = useState<keyof typeof SSO_ERROR_MESSAGES | null>(null);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

  // Read the SSO error (e.g. ?error=sso_failed) client-side only, so this page
  // stays statically prerenderable (avoiding useSearchParams' Suspense need).
  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get("error");
    if (e && e in SSO_ERROR_MESSAGES) setSsoError(e as keyof typeof SSO_ERROR_MESSAGES);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-base p-4">
      <div className="w-full max-w-sm scale-in">
        <div className="card p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent via-purple-400 to-accent opacity-60" />
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 float">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <h1 className="text-xl font-bold gradient-text">Welcome back</h1>
            <p className="mt-1 text-sm text-muted">Sign in to Prysm Note</p>
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

          <p className="mt-6 text-center text-xs text-muted">
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