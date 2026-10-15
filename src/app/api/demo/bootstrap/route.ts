// POST /api/demo/bootstrap — create the FIRST demo firm on a fresh
// deployment, over HTTPS, with no database terminal access needed (c106).
//
// This is deliberately NOT the same shape as /api/demo/reset: reset requires
// a signed-in session whose own firm already carries the demo flag, which is
// exactly right for ongoing use but is a chicken-and-egg problem the very
// first time a deployment has no demo firm yet (no firm exists for anyone to
// be signed in to). Until now that gap was closed by an operator running the
// CLI from a terminal with the database connection string in hand — the same
// credential that protects real client data once firms onboard. This route
// closes the gap without ever touching that credential: it is reachable with
// no session at all, but gated behind TWO deployment-only secrets, both of
// which must be set to a non-empty value by whoever controls this
// deployment's environment variables (never read from the request):
//
//   DEMO_RESET_ENABLED=1                the existing demo on/off switch
//   DEMO_BOOTSTRAP_SECRET=<random>       a one-time bootstrap credential
//
// Fails closed exactly like every other gate in this codebase: if either
// env var is unset, the route refuses — it does not fall back to "no secret
// required". It also refuses once a demo firm already exists (same check
// the CLI's own `create` command makes), so it cannot be replayed to spin up
// a second one; /api/demo/reset is how an existing demo firm gets refreshed
// after this.
//
// Recommended use: set DEMO_BOOTSTRAP_SECRET once, call this route once,
// then remove (or rotate) the env var — it has no further purpose once a
// demo firm exists, since the route refuses from that point on anyway.
//
// Runtime imports below are lazy (matching ../reset/route.ts and ../_lib/run.ts)
// so `next build` never needs a live database connection; the TenantRunner
// type import is type-only and is erased, so it does not defeat that.

import { timingSafeEqual } from "node:crypto";
import { errorResponse, HttpError } from "@/tenancy/route";
import type { TenantRunner } from "@/engines/demo/reset";

export const dynamic = "force-dynamic";

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch rather than returning false.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  try {
    const { demoResetEnabled, createDemoTenant, findActiveDemoTenants } = await import("@/engines/demo/reset");
    const { loadDemoStatus } = await import("@/engines/demo/status");
    const { withTenant } = await import("@/tenancy/withTenant");

    if (!demoResetEnabled()) {
      throw new HttpError(403, "The demo is switched off on this deployment (set DEMO_RESET_ENABLED=1 on a demo deployment only).");
    }
    const expected = process.env.DEMO_BOOTSTRAP_SECRET;
    if (!expected) {
      throw new HttpError(403, "Bootstrap is not configured on this deployment (DEMO_BOOTSTRAP_SECRET is not set).");
    }
    if (!secretMatches(req.headers.get("x-demo-bootstrap-secret"), expected)) {
      throw new HttpError(403, "Incorrect or missing bootstrap secret.");
    }

    const run: TenantRunner = (tenantId, fn) => withTenant(tenantId, fn);
    // Not a real firm — just a scope to run the (non-tenant-scoped) firms
    // lookup through, exactly like the CLI's own NO_TENANT (cli.ts).
    const noTenantScope = "00000000-0000-4000-8000-000000000000";
    const existing = await findActiveDemoTenants(run, noTenantScope);
    if (existing.length > 0) {
      throw new HttpError(409, `A demo firm already exists (${existing[0]!.tenantId}); use POST /api/demo/reset from a signed-in session instead.`);
    }

    const created = await createDemoTenant(run, { createdBy: "deployment bootstrap via /api/demo/bootstrap" });
    const status = await loadDemoStatus(run, created.tenantId);

    return Response.json(
      {
        tenantId: created.tenantId,
        generation: created.generation,
        summary: created.summary,
        presenterUserId: status.current?.presenterUserId ?? null,
        presenterName: status.current?.presenterName ?? null,
        adminUserId: status.current?.adminUserId ?? null,
        next:
          "Set these on this deployment, then reload /demo with no session at all: " +
          `DEV_TENANT_ID=${created.tenantId}` +
          (status.current?.presenterUserId ? `, DEV_USER_ID=${status.current.presenterUserId}` : "") +
          ", AUTH_PROVIDER=dev. After that, the Reset demo firm button on /demo keeps it fresh without ever needing this route again.",
      },
      { status: 201 }
    );
  } catch (err) {
    return errorResponse("POST /api/demo/bootstrap", err);
  }
}
