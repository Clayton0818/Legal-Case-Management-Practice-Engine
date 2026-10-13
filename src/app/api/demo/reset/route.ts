// POST /api/demo/reset — one-click reset of the DEMO firm (c106).
//
// Refused unless ALL of these hold:
//  - DEMO_RESET_ENABLED=1 on this deployment (off everywhere else);
//  - the caller is signed in with settings.manage;
//  - the caller's own firm is a flagged demo firm (current or retired) —
//    a real firm can never trigger it, and no firm id is read from the request.
// It then seeds a fresh demo firm through the engines' real services and
// retires the old one (append-only history is kept, never deleted).

import { demoRoute, HttpError } from "../_lib/run";
import { demoResetEnabled, resetDemo } from "@/engines/demo/reset";

export const dynamic = "force-dynamic";

export async function POST() {
  return demoRoute("POST /api/demo/reset", "settings.manage", async ({ run, tenantId, principal }) => {
    if (!demoResetEnabled()) {
      throw new HttpError(403, "The demo reset is switched off on this deployment (set DEMO_RESET_ENABLED=1 on a demo deployment only).");
    }
    const by = `${principal.displayName} (${principal.userId ?? "dev"}) via /demo`;
    const result = await resetDemo(run, { requestedFromTenantId: tenantId, createdBy: by });
    return {
      ...result,
      next: "Point the presenter session at the new demo firm (dev mode: DEV_TENANT_ID and DEV_USER_ID as shown on /demo) and reload.",
    };
  });
}
