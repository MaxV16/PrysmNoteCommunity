"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { BrandMark } from "@/components/ui/BrandMark";
import Link from "next/link";

export default function VerifyEmailPage() {
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState("");
  const router = useRouter();

  useEffect(() => {
    let active = true;
    const token = new URLSearchParams(window.location.search).get("token") || "";
    if (!token) {
      setStatus("error");
      setError("This verification link is missing its token.");
      return;
    }
    (async () => {
      try {
        await api.post<{ email_verified: boolean }>("/auth/verify-email", { token });
        if (!active) return;
        setStatus("success");
        setTimeout(() => {
          router.push("/");
          router.refresh();
        }, 1500);
      } catch (err) {
        if (!active) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "This link is invalid or has expired.");
      }
    })();
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-base p-4">
      <div className="w-full max-w-sm scale-in">
        <div className="card p-8 relative overflow-hidden text-center">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent via-purple-400 to-accent opacity-60" />
          <div className="mb-6 flex justify-center">
            <BrandMark size={32} />
          </div>

          {status === "loading" && (
            <p className="text-sm text-muted">Verifying your email...</p>
          )}

          {status === "success" && (
            <>
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-success/10">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <path d="m9 11 3 3L22 4" />
                </svg>
              </div>
              <h1 className="text-xl font-bold gradient-text">Email verified</h1>
              <p className="mt-2 text-sm text-muted">You&apos;re signed in — taking you to your tasks...</p>
            </>
          )}

          {status === "error" && (
            <>
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-danger/10">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="m15 9-6 6" />
                  <path d="m9 9 6 6" />
                </svg>
              </div>
              <h1 className="text-xl font-bold gradient-text">Link invalid or expired</h1>
              <p className="mt-2 text-sm text-muted">{error}</p>
              <p className="mt-4 text-xs text-muted">
                Go to the{" "}
                <Link href="/login" className="text-accent hover:text-accent-hover font-medium">
                  sign in
                </Link>{" "}
                page and use “Resend verification email”.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
