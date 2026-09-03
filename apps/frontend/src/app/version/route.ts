import { NextResponse } from "next/server";

/**
 * Reports the SHA of the currently-served frontend build (inlined from
 * NEXT_PUBLIC_GIT_SHA at build time). Served with Cache-Control: no-store so a
 * stale cached page can always learn that a newer build is live. The update
 * banner compares the SHA baked into the client bundle against this value -
 * backend-only deploys never trigger it.
 */
export function GET() {
  return NextResponse.json(
    { version: process.env.NEXT_PUBLIC_GIT_SHA || "" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
