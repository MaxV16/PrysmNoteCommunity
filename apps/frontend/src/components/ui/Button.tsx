"use client";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md" | "lg";
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonProps) {
  const base = "rounded font-semibold transition-colors outline-none";
  const variants: Record<string, string> = {
    primary: "bg-accent text-base hover:bg-accent-hover",
    secondary: "bg-elevated text-primary hover:bg-hover border border-border",
    danger: "bg-danger text-white hover:opacity-90",
  };
  const sizes: Record<string, string> = {
    sm: "px-2 py-1 text-xs",
    md: "px-3 py-1.5 text-sm",
    lg: "px-4 py-2 text-base",
  };

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
