interface AvatarProps {
  name?: string;
  src?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_CLASSES: Record<string, string> = {
  sm: "h-6 w-6 text-xs",
  md: "h-8 w-8 text-sm",
  lg: "h-10 w-10 text-base",
};

export function Avatar({ name, src, size = "md", className = "" }: AvatarProps) {
  const initials = (name || "?")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- user-supplied remote avatar; opting out of next/image
      <img
        src={src}
        alt={name || "Avatar"}
        className={`rounded-full object-cover ring-2 ring-border ${SIZE_CLASSES[size]} ${className}`}
      />
    );
  }

  return (
    <div
      className={`flex items-center justify-center rounded-full bg-accent/15 text-accent font-semibold ring-2 ring-border ${SIZE_CLASSES[size]} ${className}`}
    >
      {initials}
    </div>
  );
}
