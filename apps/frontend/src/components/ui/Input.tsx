"use client";

import { useId } from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, className = "", ...props }: InputProps) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-xs text-secondary">{label}</label>
      )}
      <input
        id={id}
        className={`rounded-md border border-border bg-elevated px-2 py-1.5 text-sm text-primary placeholder-muted outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25 ${className}`}
        {...props}
      />
    </div>
  );
}
