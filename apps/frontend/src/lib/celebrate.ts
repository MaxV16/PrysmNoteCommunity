"use client";

const PARTICLES = 34;
const DURATION_MS = 650;

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * A tiny, short-lived confetti burst drawn on a throwaway canvas. No dependency,
 * no React state, and it never blocks input (the canvas is pointer-events:none
 * and removes itself). Honors prefers-reduced-motion and the caller's rewards
 * preference.
 */
export function celebrate(origin?: { x?: number; y?: number }): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "9999";
  document.body.appendChild(canvas);

  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  const colors = [
    cssVar("--accent", "#5B5BD6"),
    cssVar("--success", "#2ed573"),
    cssVar("--warning", "#ffa502"),
  ];
  const cx = origin?.x ?? width / 2;
  const cy = origin?.y ?? height / 2;

  const particles = Array.from({ length: PARTICLES }, (_, i) => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
    const speed = 2.5 + Math.random() * 5;
    return {
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 3 + Math.random() * 3,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.35,
      color: colors[i % colors.length],
    };
  });

  const start = performance.now();
  const tick = (now: number) => {
    const progress = Math.min(1, (now - start) / DURATION_MS);
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = Math.max(0, 1 - progress);
    for (const p of particles) {
      p.vy += 0.18;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      canvas.remove();
    }
  };
  requestAnimationFrame(tick);
}
