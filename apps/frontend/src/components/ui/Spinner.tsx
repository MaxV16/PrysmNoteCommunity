export function Spinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizes: Record<string, string> = {
    sm: "h-4 w-4 border-2",
    md: "h-6 w-6 border-2",
    lg: "h-8 w-8 border-3",
  };
  return (
    <div
      className={`${sizes[size]} animate-spin rounded-full border-accent/30 border-t-accent`}
    />
  );
}