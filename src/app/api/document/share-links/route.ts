import { documentRoute } from "@/app/api/document/_lib/route";
import { bool, readJson, str, uuidOrNull } from "@/engines/document/http";
import { createShareLink, listShareLinks, type CreateShareLinkInput } from "@/engines/document/exchange/service";
import { DocumentError } from "@/engines/document/errors";

export const dynamic = "force-dynamic";

/**
 * c89 — a matter's (or one group's) outbound share links, newest first,
 * with each link's allowed/denied access counts. Needs documents.read.
 * ?matterId= and/or ?groupId= filter.
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  return documentRoute("GET /api/document/share-links", async (c) => {
    if (!c.viewer.permissions.includes("documents.read")) throw new DocumentError("Not allowed.", 403);
    const matterId = sp.get("matterId") ?? undefined;
    const groupId = sp.get("groupId") ?? undefined;
    if (!matterId && !groupId) throw new DocumentError("'matterId' or 'groupId' is required.", 422);
    return listShareLinks(c.tx, c.tenantId, { matterId, groupId });
  });
}

/**
 * c89 — create an outbound share link. Only an attorney (documents.write +
 * documents.approve) may send a document outside the firm. Body:
 * { groupId, recipientType: 'client'|'opposing_counsel'|'expert'|'other',
 *   recipientLabel?, expiresAt (ISO date), maxDownloads?,
 *   confirmSharePrivileged?, privilegedOverrideReason? }. The last two are
 * required when the document is privileged/work product/sealed, or going
 * to a 'client' recipient who is not already marked clientVisible.
 *
 * The response's `token` is the ONLY time the raw link value is ever
 * available — it is never stored, and there is no way to retrieve it again.
 */
export async function POST(req: Request) {
  return documentRoute(
    "POST /api/document/share-links",
    async (c) => {
      const body = await readJson(req);
      const groupId = uuidOrNull(body, "groupId");
      if (!groupId) throw new DocumentError("'groupId' is required.", 422);
      const input: CreateShareLinkInput = {
        groupId,
        recipientType: body.recipientType,
        recipientLabel: body.recipientLabel,
        expiresAt: str(body, "expiresAt", { required: true }),
        maxDownloads: typeof body.maxDownloads === "number" ? body.maxDownloads : undefined,
        confirmSharePrivileged: bool(body, "confirmSharePrivileged"),
        privilegedOverrideReason: body.privilegedOverrideReason,
      };
      return createShareLink(c.tx, c, input);
    },
    { status: 201 }
  );
}
