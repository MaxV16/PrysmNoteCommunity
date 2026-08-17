"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";

export default function ResetPasswordPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams?.token || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!token) {
      setStatus("error");
      setError("This reset link is missing its token. Request a new one.");
      return;
    }
    if (password.length < 8) {
      setStatus("error");
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setStatus("error");
      setError("Passwords don't match");
      return;
    }
    setStatus("sending");
    try {
      await api.post<{ status: string }>("/auth/reset-password", {
        token,
        new_password: password,
      });
      setStatus("ok");
      setTimeout(() => router.push("/login"), 1500);
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
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
            </div>
            <h1 className="text-xl font-bold gradient-text">Choose a new password</h1>
            <p className="mt-1 text-sm text-muted">Pick a strong password for your account</p>
          </div>

          {status === "ok" && (
            <div className="mb-4 rounded-lg bg-success/10 px-4 py-2.5 text-sm text-success">
              Password updated. Redirecting you to sign in...
            </div>
          )}
          {status === "error" && error && (
            <div className="mb-4 rounded-lg bg-danger/10 px-4 py-2.5 text-sm text-danger">
              {error}
            </div>
          )}

          {!token && status !== "ok" && (
            <div className="rounded-lg bg-warning/10 px-4 py-2.5 text-sm text-warning">
              This link is missing its reset token — it may be truncated. Request a new reset link.
            </div>
          )}

          {status !== "ok" && (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-secondary">New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="input-field"
                  required
                  minLength={8}
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-secondary">Confirm password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat your password"
                  className="input-field"
                  required
                  minLength={8}
                />
              </div>
              <button
                type="submit"
                disabled={status === "sending"}
                className="btn btn-primary mt-2 w-full py-2.5 text-sm disabled:opacity-50"
              >
                {status === "sending" ? "Updating..." : "Update password"}
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-xs text-muted">
            <Link href="/login" className="text-accent hover:text-accent-hover font-medium">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
