"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { ThreePaneLayout } from "@/components/layout/ThreePaneLayout";
import { Spinner } from "@/components/ui/Spinner";

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  if (loading || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-base">
        <Spinner />
      </div>
    );
  }

  return <ThreePaneLayout />;
}
