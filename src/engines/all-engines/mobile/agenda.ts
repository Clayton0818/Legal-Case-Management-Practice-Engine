// c100 -- lawyer mobile agenda: today's calendar events and open tasks due.
//
// This is a pure projection over two already-shared reads -- the
// `calendar_events` table in src/db/tables/foundation.ts and
// src/core/tasks.ts's listOpenTasks() -- so the all-engines slug owns no
// agenda data of its own and no new table is introduced here. See the PR
// description for what c100 asked for that is NOT in this file (client
// messaging, time tracking, document bytes) and why.

import { and, asc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { calendarEvents } from "@/db/tables/foundation";
import { assertCan, FIRM } from "@/core/permissions";
import { listOpenTasks, type TaskRow } from "@/core/tasks";
import type { TenantTx } from "@/tenancy/withTenant";
import { AllEnginesError } from "../common/errors";
import type { StaffContext } from "../permissions/service";

type CalendarEventRow = typeof calendarEvents.$inferSelect;

export interface AgendaEvent {
  id: string;
  matterId: string | null;
  eventType: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  location: string | null;
  status: string;
  isDeadline: boolean;
}

export interface AgendaTask {
  id: string;
  matterId: string | null;
  kind: string;
  title: string;
  dueAt: Date;
  deadlineCritical: boolean;
}

export interface MobileAgenda {
  asOf: Date;
  windowEnd: Date;
  events: AgendaEvent[];
  tasksDue: AgendaTask[];
}

/**
 * Pure: the end of the agenda window. c100 v1 is "the rest of today" -- the
 * next UTC midnight after `now`. (A per-tenant/firm timezone for "today" is
 * a reasonable v2 refinement; flagged in the PR description, not done here.)
 */
export function agendaWindowEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
}

function toAgendaEvent(e: CalendarEventRow): AgendaEvent {
  return {
    id: e.id,
    matterId: e.matterId,
    eventType: e.eventType,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    allDay: e.allDay,
    location: e.location,
    status: e.status,
    isDeadline: e.isDeadline,
  };
}

function toAgendaTask(t: TaskRow): AgendaTask {
  return {
    id: t.id,
    matterId: t.matterId,
    kind: t.kind,
    title: t.title,
    dueAt: t.dueAt,
    deadlineCritical: t.deadlineCritical,
  };
}

/**
 * The signed-in user's agenda for today: their own calendar events (not
 * cancelled, starting before the window end) plus their own open tasks due
 * before the window end. c100: "see today's calendar" + part of "track
 * time, approve AI-drafted updates" (the task list half of that).
 */
export async function loadMobileAgenda(
  tx: TenantTx,
  tenantId: string,
  viewer: StaffContext,
  opts: { now?: Date } = {}
): Promise<MobileAgenda> {
  assertCan(viewer.actor, "calendar.view", FIRM, viewer.config);
  if (!viewer.userId) throw new AllEnginesError("No signed-in user to build an agenda for.", 400);

  const now = opts.now ?? new Date();
  const windowEnd = agendaWindowEnd(now);

  const eventRows = await tx
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.tenantId, tenantId),
        ne(calendarEvents.status, "cancelled"),
        gte(calendarEvents.startsAt, now),
        lt(calendarEvents.startsAt, windowEnd),
        sql`${viewer.userId}::uuid = any(${calendarEvents.assignedUserIds})`
      )
    )
    .orderBy(asc(calendarEvents.startsAt))
    .limit(100);

  const taskRows = await listOpenTasks(tx, tenantId, { ownerUserId: viewer.userId, dueBefore: windowEnd, limit: 200 });

  return {
    asOf: now,
    windowEnd,
    events: eventRows.map(toAgendaEvent),
    tasksDue: taskRows.map(toAgendaTask),
  };
}
