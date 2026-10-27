// `firms` is the one table in this schema that is deliberately NOT
// tenant-scoped (docs/architecture/core-data-model-schema-design.md §2.1:
// "Not itself tenant-scoped — there is nothing above it to scope against").
// A worker that needs to poll across every tenant's `scheduled_tasks`
// therefore needs a legitimate way to enumerate firms without a tenantId to
// pass to withTenant() first — that's what this narrow, read-only export
// is for. It does not become a general-purpose escape hatch: it returns
// only firm ids, nothing else, and every subsequent query still goes
// through withTenant() scoped to one of those ids.

import { rawDb } from "./db";
import { firms } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";

export async function listActiveFirmIds(): Promise<string[]> {
  const rows = await rawDb
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.status, "active"));
  return rows.map((r) => r.id);
}

/**
 * Client portal (c11): resolve the firm named in /portal/<slug> before there
 * is a tenantId to scope by — the same narrow, read-only exception as
 * listActiveFirmIds(). Only trial/active firms; returns only what the portal
 * needs (id for withTenant(), display name, and whether it is a production
 * firm, which decides if a dev sign-in link may ever be shown on screen).
 */
export interface PortalFirm {
  id: string;
  name: string;
  slug: string;
  isProduction: boolean;
}

export async function findPortalFirmBySlug(slug: string): Promise<PortalFirm | null> {
  const [row] = await rawDb
    .select({ id: firms.id, name: firms.name, slug: firms.slug, isProduction: firms.isProduction })
    .from(firms)
    .where(and(eq(firms.slug, slug), inArray(firms.status, ["trial", "active"])))
    .limit(1);
  return row ?? null;
}
