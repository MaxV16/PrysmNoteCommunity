"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

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
      <div className="w-full max-w-sm card p-8 fade-in">
        <div className="mb-8 text-center">
          <div className="mb-3 text-3xl">&#x1F3AF;</div>
          <h1 className="text-xl font-bold text-primary">Welcome back</h1>
          <p className="mt-1 text-sm text-muted">Sign in to Prysm Note</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-danger/10 px-4 py-2.5 text-sm text-danger">
            {error}
          </div>
        )}

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
            className="btn mt-2 w-full bg-accent py-2.5 text-sm font-semibold text-base hover:bg-accent-hover disabled:opacity-50"
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
  );
}