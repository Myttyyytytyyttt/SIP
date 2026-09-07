/**
 * Liveness for Docker and Railway. The image's HEALTHCHECK fetches this and
 * nothing else, so it must never depend on anything that can be down — and
 * with the mock there is nothing to depend on anyway.
 */
export function GET(): Response {
  return Response.json({ ok: true, service: "@sip/web" });
}
