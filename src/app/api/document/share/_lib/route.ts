// Route wrapper for the PUBLIC, unauthenticated share-link endpoints
// (c89) — src/app/api/document/share/[token]/**. There is no session here:
// this is the one place in the whole API designed to be reachable by
// someone who has never signed in, so it does NOT use documentRoute()
// (@/app/api/document/_lib/route.ts), which assumes a staff principal.
//
// Tenant resolution never trusts anything from the request except the
// token itself: parseShareToken() reads the tenant id OUT of the token
// (see exchange/crypto.ts for why that is safe), and everything after that
// runs inside withTenant() scoped to exactly that tenant. If the token is
// forged, malformed, or names a tenant it does not actually belong to, the
// lookup inside that transaction simply finds no matching row — RLS plus
// the (tenant_id, token_hash) unique index mean there is no way to land on
// a different tenant's data by guessing or editing the token.
//
// Same "handled errors answer INSIDE the transaction" shape as
// documentRoute, for the same reason: a denied/expired/revoked access is
// still something document_access_log must keep a row for, and an
// exception thrown out of withTenant()'s callback rolls the whole
// transaction back, which would silently lose that row.

import { parseShareToken } from "@/engines/document/exchange/crypto";
import { mapHandledError } from "@/engines/document/http";
import type { TenantTx } from "@/tenancy/withTenant";

type Envelope = { ok: true; value: unknown } | { ok: false; error: { status: number; body: Record<string, unknown> } };

export async function shareTokenRoute(
  label: string,
  rawToken: string,
  handler: (tx: TenantTx, tenantId: string, secret: string) => Promise<unknown>
): Promise<Response> {
  const parsed = parseShareToken(rawToken);
  if (!parsed) return Response.json({ error: "This link is not valid." }, { status: 404 });

  try {
    const { withTenant } = await import("@/tenancy/withTenant");
    const envelope = await withTenant(parsed.tenantId, async (tx): Promise<Envelope> => {
      try {
        return { ok: true, value: await handler(tx, parsed.tenantId, parsed.secret) };
      } catch (err) {
        const mapped = mapHandledError(err);
        if (!mapped) throw err;
        return { ok: false, error: mapped };
      }
    });
    if (!envelope.ok) return Response.json(envelope.error.body, { status: envelope.error.status });
    if (envelope.value instanceof Response) return envelope.value;
    return Response.json(envelope.value ?? null, { status: 200 });
  } catch (err) {
    console.error(JSON.stringify({ level: "error", event: "document.share.failed", label, error: err instanceof Error ? err.message : String(err) }));
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
