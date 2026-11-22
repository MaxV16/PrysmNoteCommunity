/**
 * Content-Security-Policy builder.
 *
 * The policy lives here, not in `next.config.ts`, because scripts need a
 * per-request nonce: Next.js only stamps the nonce onto its own inline
 * bootstrap scripts when the CSP arrives on the REQUEST headers, which is what
 * `middleware.ts` does. Keep this pure so both callers agree and so it can be
 * unit tested without a server.
 */

/** Origin that serves uploaded images (`NEXT_PUBLIC_API_URL`), empty when unset. */
export function uploadedImageOrigin(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || "").origin;
  } catch {
    return "";
  }
}

export function buildCsp(options: { nonce?: string; isProd: boolean; uploadedImages?: string }): string {
  const { nonce, isProd } = options;
  const uploaded = options.uploadedImages ?? uploadedImageOrigin();

  // Production: no 'unsafe-inline'. Each script must carry the nonce; the
  // nonce-bearing Next runtime may then load its own chunk scripts
  // ('strict-dynamic'). Development keeps the permissive form because the dev
  // server injects inline HMR scripts that never carry a nonce.
  const scriptSrc = isProd
    ? `script-src 'self'${nonce ? ` 'nonce-${nonce}' 'strict-dynamic'` : ""} https://static.cloudflareinsights.com`
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com";

  return [
    "default-src 'self'",
    // Cloudflare Web Analytics beacon (static.cloudflareinsights.com) is loaded
    // as an afterInteractive script when NEXT_PUBLIC_CF_ANALYTICS_BEACON is set.
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // TMDB hosts: posters/search thumbs/provider logos (image.tmdb.org) + the
    // TMDB attribution logo in the watchlist footer (www.themoviedb.org).
    `img-src 'self' data: blob: https://image.tmdb.org https://www.themoviedb.org${uploaded ? ` ${uploaded}` : ""}`,
    "font-src 'self' https://fonts.gstatic.com data:",
    // Browser-side LLM calls go straight to the provider APIs, and the Google
    // Fonts stylesheet is loaded from its CDN. The google.com hosts are required
    // by the browser Web Speech API (SpeechRecognition) for speech-to-text - not
    // by app code - so keep them explicit, no wildcards. cloudflareinsights.com
    // serves the Web Analytics beacon (sendBeacon -> /cdn-cgi/rum).
    "connect-src 'self' https://api.openai.com https://generativelanguage.googleapis.com https://api.deepseek.com https://openrouter.ai https://fonts.googleapis.com https://www.google.com https://speech.google.com https://speech.googleapis.com wss://www.google.com https://cloudflareinsights.com" +
      (isProd ? "" : " http://localhost:8000"),
    // Behind Cloudflare's proxy the page origin is always https, but if nginx
    // ever serves plain http (trailing-slash 307 from a mis-trusted
    // X-Forwarded-Proto), upgrade any subresource request to https.
    ...(isProd ? ["upgrade-insecure-requests"] : []),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
