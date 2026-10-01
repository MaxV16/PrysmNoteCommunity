"use client";

import { useId } from "react";

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
}

export function Select({ label, options, placeholder, className = "", ...props }: SelectProps) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <div className="flex flex-col gap-1">
      {label && <label htmlFor={id} className="text-xs text-secondary">{label}</label>}
      <div className="relative">
        <select
          id={id}
          className={`rounded border border-border bg-elevated px-2 py-1.5 text-sm text-primary outline-none focus:border-accent appearance-none pr-8 cursor-pointer ${className}`}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>{placeholder}</option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted text-xs">
          {"\u25BC"}
        </div>
      </div>
    </div>
  );
}
