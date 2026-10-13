// Operator CLI for the DEMO firm (c106). Run with tsx on a DEMO deployment:
//
//   DEMO_RESET_ENABLED=1 npx tsx src/engines/demo/cli.ts create --by "Clayton"
//   DEMO_RESET_ENABLED=1 npx tsx src/engines/demo/cli.ts reset  --by "Clayton"
//   DEMO_RESET_ENABLED=1 npx tsx src/engines/demo/cli.ts retire --by "Clayton"   (switch the demo off)
//   npx tsx src/engines/demo/cli.ts status
//
// Uses DATABASE_URL (the app_runtime role, RLS enforced) — the demo needs no
// elevated access. `create` makes the FIRST demo firm (the web reset can only
// be pressed from inside a demo firm); `reset` resets from the current demo
// firm, exactly like the /demo button. Both refuse unless
// DEMO_RESET_ENABLED=1, so they cannot be run against a production database
// by accident. Neither ever touches a firm that lacks the demo flag.

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { withTenant } from "@/tenancy/withTenant";
import { ensureServerApprovals } from "@/compliance/server";
import { createDemoTenant, currentDemoTenant, demoResetEnabled, findActiveDemoTenants, resetDemo, retireDemoTenant, type TenantRunner } from "./reset";
import { loadDemoStatus } from "./status";

const run: TenantRunner = (tenantId, fn) => withTenant(tenantId, fn);
/** A scope that sees no tenant rows — only the (not tenant-scoped) firms list. */
const NO_TENANT = () => randomUUID();

function printSetup(tenantId: string, presenterUserId: string | null) {
  console.log("\nPoint the demo deployment's presenter session at it (dev mode):");
  console.log(`  DEV_TENANT_ID=${tenantId}`);
  console.log(`  DEV_USER_ID=${presenterUserId ?? "<the partner's users.id>"}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { by: { type: "string" } } });
  await ensureServerApprovals();

  if (command === "status") {
    const current = await currentDemoTenant(run, NO_TENANT());
    if (!current) return void console.log("No active demo firm.");
    const status = await loadDemoStatus(run, current.tenantId);
    console.log(`Current demo firm: ${current.tenantId} (generation ${current.generation}, seeded ${current.seededAt?.toISOString() ?? "—"})`);
    printSetup(current.tenantId, status.current?.presenterUserId ?? null);
    return;
  }

  if (command !== "create" && command !== "reset" && command !== "retire") {
    throw new Error("Usage: cli.ts create|reset|retire|status [--by \"Operator name\"]");
  }
  if (!demoResetEnabled()) throw new Error("Refusing: set DEMO_RESET_ENABLED=1 (only on a demo deployment's database).");
  const by = values.by?.trim();
  if (!by) throw new Error("Say who is doing this: --by \"Your name\".");

  if (command === "retire") {
    const active = await findActiveDemoTenants(run, NO_TENANT());
    for (const a of active) {
      await run(a.tenantId, (tx) => retireDemoTenant(tx, { tenantId: a.tenantId, replacedByTenantId: null, reason: `Demo switched off by ${by} (cli)` }));
      console.log(`Retired demo firm ${a.tenantId}.`);
    }
    if (active.length === 0) console.log("No active demo firm.");
    return;
  }

  let tenantId: string;
  if (command === "create") {
    const existing = await currentDemoTenant(run, NO_TENANT());
    if (existing) throw new Error(`A demo firm already exists (${existing.tenantId}); use 'reset' instead.`);
    const created = await createDemoTenant(run, { createdBy: `${by} (cli)` });
    tenantId = created.tenantId;
    console.log(`Created demo firm ${tenantId}:`, created.summary);
  } else {
    const current = await currentDemoTenant(run, NO_TENANT());
    if (!current) throw new Error("No active demo firm to reset from; use 'create'.");
    const result = await resetDemo(run, { requestedFromTenantId: current.tenantId, createdBy: `${by} (cli)` });
    tenantId = result.newTenantId;
    console.log(`Reset: new demo firm ${tenantId} (generation ${result.generation}); retired ${result.retiredTenantIds.join(", ")}`, result.summary);
  }
  const status = await loadDemoStatus(run, tenantId);
  printSetup(tenantId, status.current?.presenterUserId ?? null);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
