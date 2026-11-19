// c74 — lead-source attribution for one intake session. GET returns what's
// recorded; PATCH lets staff capture or correct it (a front-desk fix, or a
// phone-tracking vendor resolving a campaign after the call). Internal
// only: this is marketing-attribution metadata, never shown to a client,
// and it never carries case content.
import { HttpError, tenantRoute } from "@/tenancy/route";
import { getLeadAttribution, upsertLeadAttribution } from "@/engines/intake/attribution/service";
import type { LeadAttributionInput } from "@/engines/intake/attribution/model";
import { readJson, requireActingStaff, uuid, type Body } from "../../../_lib/http";

export const dynamic = "force-dynamic";

function optionalAttributionStr(body: Body, key: string): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `'${key}' must be a string.`);
  return v;
}

function parseAttributionBody(body: Body): LeadAttributionInput {
  return {
    landingPage: optionalAttributionStr(body, "landingPage"),
    campaignTag: optionalAttributionStr(body, "campaignTag"),
    isGoogleAds: typeof body.isGoogleAds === "boolean" ? body.isGoogleAds : undefined,
    directoryName: optionalAttributionStr(body, "directoryName"),
    referralSource: optionalAttributionStr(body, "referralSource"),
    phoneTrackingNumber: optionalAttributionStr(body, "phoneTrackingNumber"),
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("GET /api/intake/sessions/[id]/attribution", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return getLeadAttribution(tx, tenantId, uuid(id, "session id"));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("PATCH /api/intake/sessions/[id]/attribution", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    const body = await readJson(req);
    return upsertLeadAttribution(tx, tenantId, uuid(id, "session id"), parseAttributionBody(body));
  });
}
