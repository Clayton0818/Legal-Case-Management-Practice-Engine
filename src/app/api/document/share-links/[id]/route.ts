import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam, readJson, str } from "@/engines/document/http";
import { getShareLinkDetail, revokeShareLink } from "@/engines/document/exchange/service";
import { DocumentError } from "@/engines/document/errors";

export const dynamic = "force-dynamic";

/** c89 — one share link plus its full access history. Needs documents.read. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return documentRoute("GET /api/document/share-links/[id]", async (c) => {
    if (!c.viewer.permissions.includes("documents.read")) throw new DocumentError("Not allowed.", 403);
    return getShareLinkDetail(c.tx, c.tenantId, assertUuidParam(id, "share link id"));
  });
}

/** c89 — revoke a share link: { reason }. Links are revoked, never deleted. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return documentRoute("POST /api/document/share-links/[id]", async (c) => {
    const reason = str(await readJson(req), "reason", { required: true, max: 1000 })!;
    return revokeShareLink(c.tx, c, assertUuidParam(id, "share link id"), reason);
  });
}
