// c123 — the AI case assistant for one matter (staff only).
//   POST { mode: "ask", question }  → a cited answer from the matter's records
//   POST { mode: "briefing" }       → "catch me up", built from the records
// What the person may see, and what may reach a model, is decided in
// src/engines/all-engines/caseAssistant/service.ts. Every call is audited.
import { allEnginesRoute } from "@/app/api/all-engines/_lib/route";
import { isUuid, readBody, reqString } from "@/engines/all-engines/common/body";
import { AllEnginesError } from "@/engines/all-engines/common/errors";
import { askCaseAssistant, caseBriefing } from "@/engines/all-engines/caseAssistant/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return allEnginesRoute("POST /api/all-engines/matters/:id/assistant", async ({ tx, tenantId, staff }) => {
    if (!isUuid(id)) throw new AllEnginesError("Invalid matter id.", 400);
    const body = await readBody(req);
    if (body.mode === "briefing") return caseBriefing(tx, { tenantId, staff, matterId: id });
    if (body.mode !== "ask") throw new AllEnginesError("'mode' must be 'ask' or 'briefing'.", 400);
    return askCaseAssistant(tx, { tenantId, staff, matterId: id, question: reqString(body, "question") });
  });
}
