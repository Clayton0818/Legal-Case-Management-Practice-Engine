import { shareTokenRoute } from "@/app/api/document/share/_lib/route";
import { contentDisposition } from "@/engines/document/http";
import { downloadSharedDocument } from "@/engines/document/exchange/service";

export const dynamic = "force-dynamic";

/**
 * c89 — PUBLIC, unauthenticated. The bytes of the version pinned to this
 * share link, checksum-verified, counted against maxDownloads and logged
 * as 'download' (allowed or denied) in document_access_log, actorType
 * 'external_recipient'. A successful download also marks the document
 * group 'sent' / 'platform' if delivery was still outstanding (c40).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return shareTokenRoute("GET /api/document/share/[token]/download", token, async (tx, tenantId, secret) => {
    const file = await downloadSharedDocument(tx, tenantId, secret, undefined);
    return new Response(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "content-type": file.mimeType,
        "content-disposition": contentDisposition(file.filename, false),
        "content-length": String(file.bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "x-document-sha256": file.sha256,
      },
    });
  });
}
