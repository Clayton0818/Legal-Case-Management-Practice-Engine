// c100 -- lawyer mobile task list: the signed-in user's own open tasks. A
// thin wrapper over src/core/tasks.ts -- this engine owns no task data of
// its own. Read-only in this PR; see the PR description for why completing
// a task from the phone isn't wired up here yet.

import { assertCan, FIRM } from "@/core/permissions";
import { listOpenTasks, type TaskRow } from "@/core/tasks";
import type { TenantTx } from "@/tenancy/withTenant";
import { AllEnginesError } from "../common/errors";
import type { StaffContext } from "../permissions/service";

export interface MobileTask {
  id: string;
  matterId: string | null;
  kind: string;
  title: string;
  description: string | null;
  dueAt: Date;
  deadlineCritical: boolean;
}

function toMobileTask(t: TaskRow): MobileTask {
  return {
    id: t.id,
    matterId: t.matterId,
    kind: t.kind,
    title: t.title,
    description: t.description,
    dueAt: t.dueAt,
    deadlineCritical: t.deadlineCritical,
  };
}

/** The signed-in user's own open tasks, soonest due first. c100: "the user's open tasks". */
export async function listMyTasks(tx: TenantTx, tenantId: string, viewer: StaffContext): Promise<MobileTask[]> {
  assertCan(viewer.actor, "calendar.view", FIRM, viewer.config);
  if (!viewer.userId) throw new AllEnginesError("No signed-in user to list tasks for.", 400);

  const rows = await listOpenTasks(tx, tenantId, { ownerUserId: viewer.userId, limit: 200 });
  return rows.map(toMobileTask);
}
