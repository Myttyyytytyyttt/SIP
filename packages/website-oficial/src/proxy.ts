/**
 * THE SECURITY HEADERS, SENT PER REQUEST (Next 16's `proxy` convention, which
 * replaced `middleware`).
 *
 * `next.config.mjs`'s `headers()` is compiled into the route manifest at BUILD
 * time, so any origin the policy has to allow — the browser's Solana WebSocket,
 * above all — was frozen into the image. An operator who set SIP_SOLANA_PUBLIC_WS_URL
 * at restart got a Content-Security-Policy that did not name it, and the only
 * symptom was a blocked request in the browser with nothing on the server to
 * explain it. Middleware runs per request, so a restart is enough again.
 *
 * The static headers stay in next.config.mjs as the floor: if this middleware
 * ever fails to match a path, the response is still not policy-free.
 */
import { NextResponse, type NextRequest } from "next/server";

import { securityHeaders } from "../security-headers.mjs";

export default function proxy(_request: NextRequest): NextResponse {
  const response = NextResponse.next();
  for (const { key, value } of securityHeaders()) response.headers.set(key, value);
  return response;
}

export const config = {
  // Everything a browser renders or calls. Static assets under /_next/static are
  // immutable and carry no policy-relevant surface.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
