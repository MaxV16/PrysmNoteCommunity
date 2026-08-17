export function BrandMark({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg ${className}`}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand mark */}
      <img
        src="/prysm-logo.png"
        alt="Prysm Note"
        width={size}
        height={size}
        className="h-full w-full object-cover"
      />
    </span>
  );
}
