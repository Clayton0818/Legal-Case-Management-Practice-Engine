import { shareTokenRoute } from "@/app/api/document/share/_lib/route";
import { viewSharedDocument } from "@/engines/document/exchange/service";

export const dynamic = "force-dynamic";

/**
 * c89 — PUBLIC, unauthenticated. The recipient's landing page data for one
 * share link: title, who it was shared with, when it expires and basic
 * file metadata. Never requires a session. Logged as 'view' (allowed or
 * denied) in document_access_log, actorType 'external_recipient'.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return shareTokenRoute("GET /api/document/share/[token]", token, (tx, tenantId, secret) => viewSharedDocument(tx, tenantId, secret));
}
