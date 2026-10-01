import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        "mono-timeline": ["'DM Mono'", "'SF Mono'", "Consolas", "monospace"],
        ui: ["var(--font-ui)"],
      },
      colors: {
        base: "var(--bg-base)",
        surface: "var(--bg-surface)",
        elevated: "var(--bg-elevated)",
        hover: "var(--bg-hover)",
        border: "var(--border)",
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        muted: "var(--text-muted)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        danger: "var(--danger)",
        success: "var(--success)",
        warning: "var(--warning)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      borderColor: {
        DEFAULT: "var(--border)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        glow: "var(--shadow-glow)",
        "glow-lg": "var(--shadow-glow-strong)",
      },
      animation: {
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.2s ease-out",
      },
    },
  },
  plugins: [
    // Tailwind 3.4 ships no `pointer-*` variants (they landed in v4.1), but the
    // app uses `pointer-coarse:` across ~15 files for touch targets. Register
    // them here so those utilities actually compile instead of being dropped.
    plugin(({ addVariant }) => {
      addVariant("pointer-coarse", "@media (pointer: coarse)");
      addVariant("pointer-fine", "@media (pointer: fine)");
      addVariant("any-pointer-coarse", "@media (any-pointer: coarse)");
      addVariant("any-pointer-fine", "@media (any-pointer: fine)");
    }),
  ],
};

export default config;
