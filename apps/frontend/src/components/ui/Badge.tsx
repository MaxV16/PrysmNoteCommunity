"use client";

interface BadgeProps {
  children: string;
  color?: string;
  className?: string;
}

export function Badge({ children, color, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${className}`}
      style={{
        backgroundColor: color ? `${color}20` : "var(--bg-elevated)",
        color: color || "var(--text-secondary)",
      }}
    >
      {children}
    </span>
  );
}
