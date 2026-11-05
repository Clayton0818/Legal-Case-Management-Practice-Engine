// c100 -- lawyer mobile alerts: list and acknowledge the signed-in user's
// own open flags. A thin wrapper over src/core/flags.ts -- this engine owns
// no flag data of its own.

import { assertCan, FIRM } from "@/core/permissions";
import { acknowledgeFlag, listInternalFlags, type FlagRow } from "@/core/flags";
import type { TenantTx } from "@/tenancy/withTenant";
import { AllEnginesError, ENGINE } from "../common/errors";
import type { StaffContext } from "../permissions/service";

export interface MobileAlert {
  id: string;
  type: string;
  severity: string;
  title: string;
  summary: string | null;
  matterId: string | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
}

function toMobileAlert(f: FlagRow): MobileAlert {
  return {
    id: f.id,
    type: f.type,
    severity: f.severity,
    title: f.title,
    summary: f.summary,
    matterId: f.matterId,
    createdAt: f.createdAt,
    acknowledgedAt: f.acknowledgedAt,
  };
}

/** The signed-in user's own open flags (any audience), newest first. c100: "get alerts". */
export async function listMyAlerts(tx: TenantTx, tenantId: string, viewer: StaffContext): Promise<MobileAlert[]> {
  assertCan(viewer.actor, "flags.internal", FIRM, viewer.config);
  if (!viewer.userId) throw new AllEnginesError("No signed-in user to list alerts for.", 400);

  const rows = await listInternalFlags(tx, tenantId, { userId: viewer.userId, openOnly: true, limit: 100 });
  return rows.map(toMobileAlert);
}

/** Acknowledge one of the signed-in user's own alerts. c100: "acknowledge them". */
export async function acknowledgeMyAlert(tx: TenantTx, tenantId: string, viewer: StaffContext, flagId: string): Promise<MobileAlert> {
  assertCan(viewer.actor, "flags.acknowledge", FIRM, viewer.config);
  if (!viewer.userId) throw new AllEnginesError("No signed-in user to acknowledge as.", 400);

  const row = await acknowledgeFlag(tx, { tenantId, flagId, userId: viewer.userId, engine: ENGINE });
  return toMobileAlert(row);
}
