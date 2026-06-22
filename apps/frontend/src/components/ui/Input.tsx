"use client";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, className = "", ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label className="text-xs text-secondary">{label}</label>
      )}
      <input
        className={`rounded border border-border bg-elevated px-2 py-1.5 text-sm text-primary placeholder-muted outline-none focus:border-accent ${className}`}
        {...props}
      />
    </div>
  );
}
