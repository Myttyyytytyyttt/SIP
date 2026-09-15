/**
 * Liveness for manual checks, uptime monitors and the local Docker rehearsal's
 * HEALTHCHECK. Nothing on Vercel probes it. It must never depend on anything
 * that can be down, so it says nothing about the configuration: /wallets does.
 */
export function GET(): Response {
  return Response.json({ ok: true, service: "@sip/web" });
}
