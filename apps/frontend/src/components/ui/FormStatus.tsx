"use client";

import type { ReactNode } from "react";

type FormStatusVariant = "success" | "error" | "warning" | "info";

// One shared status banner for every form in the app. Success/info announce
// politely (role="status"), errors announce immediately (role="alert") so
// screen readers pick them up. Colors come from the design tokens only, so the
// banner renders correctly in every theme.
export function FormStatus({
  variant,
  children,
  className = "",
}: {
  variant: FormStatusVariant;
  children: ReactNode;
  className?: string;
}) {
  const styles: Record<FormStatusVariant, string> = {
    success: "border-success/40 bg-success/10 text-success",
    error: "border-danger/40 bg-danger/10 text-danger",
    warning: "border-warning/40 bg-warning/10 text-warning",
    info: "border-border bg-elevated text-secondary",
  };

  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={`rounded-lg border px-4 py-2.5 text-sm ${styles[variant]} ${className}`}
    >
      {children}
    </div>
  );
}
