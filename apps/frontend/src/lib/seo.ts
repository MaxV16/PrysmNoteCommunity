// Shared social preview asset. Kept as a static file so every page can reuse
// one 1200x630 image without a runtime image renderer.
export const OG_IMAGE = {
  url: "/og-image.png",
  width: 1200,
  height: 630,
  alt: "Prysm Note, an AI task manager for plans, notes and habits",
} as const;
