"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setStatus("sending");
    try {
      await api.post<{ status: string }>("/auth/forgot-password", { email });
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-base p-4">
      <div className="w-full max-w-sm scale-in">
        <div className="card p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent via-purple-400 to-accent opacity-60" />
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 float">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
            <h1 className="text-xl font-bold gradient-text">Reset your password</h1>
            <p className="mt-1 text-sm text-muted">Enter your email and we&apos;ll send you a reset link</p>
          </div>

          {status === "sent" && (
            <div className="mb-4 space-y-2">
              <div className="rounded-lg bg-success/10 px-4 py-2.5 text-sm text-success">
                If an account exists for that email, a reset link is on its way. Check your inbox.
              </div>
              <div className="rounded-lg bg-elevated border border-border px-4 py-2.5 text-xs text-secondary">
                Signed up with Google or GitHub instead? Those accounts don&apos;t have a password
                to reset — just use the <span className="text-accent">Continue with Gmail / GitHub</span>{" "}
                buttons on the sign-in page.
              </div>
            </div>
          )}
          {status === "error" && error && (
            <div className="mb-4 rounded-lg bg-danger/10 px-4 py-2.5 text-sm text-danger">
              {error}
            </div>
          )}

          {status === "sent" ? (
            <div className="text-center">
              <Link href="/login" className="text-sm text-accent hover:text-accent-hover font-medium">
                Back to sign in
              </Link>
            </div>
          ) : (
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
              <button
                type="submit"
                disabled={status === "sending"}
                className="btn btn-primary mt-2 w-full py-2.5 text-sm disabled:opacity-50"
              >
                {status === "sending" ? "Sending..." : "Send reset link"}
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-xs text-muted">
            Remembered it?{" "}
            <Link href="/login" className="text-accent hover:text-accent-hover font-medium">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
