"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { BrandMark } from "@/components/ui/BrandMark";

export function NotFoundView() {
  const { user, loading } = useAuth();
  const authed = !loading && Boolean(user);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-base px-4 text-center">
      <div className="flex items-center gap-2 font-bold text-primary">
        <BrandMark size={28} />
        Prysm Note
      </div>

      <div className="mt-8 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </div>

      <h1 className="mt-5 text-2xl font-extrabold text-primary">
        We could not find that page
      </h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-secondary">
        The link may be old, or the page may have moved. Everything else is
        exactly where you left it.
      </p>

      <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
        {authed ? (
          <Link href="/" className="btn-gradient rounded-lg px-6 py-3 text-sm font-semibold">
            Back to your workspace
          </Link>
        ) : (
          <>
            <Link href="/register" className="btn-gradient rounded-lg px-6 py-3 text-sm font-semibold">
              Start for free
            </Link>
            <Link
              href="/login"
              className="rounded-lg border border-border bg-surface px-6 py-3 text-sm font-semibold text-primary hover:bg-hover transition-colors"
            >
              Sign in
            </Link>
          </>
        )}
      </div>

      {!authed && (
        <div className="mt-6 flex items-center gap-4 text-xs text-muted">
          <Link href="/marketing/features" className="hover:text-primary">
            Features
          </Link>
          <Link href="/pricing" className="hover:text-primary">
            Pricing
          </Link>
        </div>
      )}
    </main>
  );
}

export default NotFoundView;
