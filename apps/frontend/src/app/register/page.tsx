"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      await register(email, password, displayName || undefined);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-base p-4">
      <div className="w-full max-w-sm card p-8 fade-in">
        <div className="mb-8 text-center">
          <div className="mb-3 text-3xl">&#x2728;</div>
          <h1 className="text-xl font-bold text-primary">Create account</h1>
          <p className="mt-1 text-sm text-muted">Get started with Prysm Note</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-danger/10 px-4 py-2.5 text-sm text-danger">
            {error}
          </div>
        )}

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
            className="btn mt-2 w-full bg-accent py-2.5 text-sm font-semibold text-base hover:bg-accent-hover disabled:opacity-50"
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
  );
}