// c123 — the AI model behind the case assistant, as an interface.
//
// No real model is wired in by this PR. The shared 'vendor.ai_model' gate
// (src/compliance/gates.ts, reused, never redefined) is pending, and choosing
// which vendor processes a firm's matter data is part of that review. Until a
// real adapter is set AND the gate is approved, the assistant answers in
// 'records' mode (cited records, no model), and the page says so.
//
// A real adapter only has to turn { system, user } into the model's text
// reply; everything else (what it may see, parsing, citation checks, audit)
// stays in this engine.

export interface CaseAssistantModel {
  /** e.g. 'anthropic:<model id>'; recorded on every answer's audit row. */
  readonly name: string;
  complete(prompt: { system: string; user: string }): Promise<string>;
}

let model: CaseAssistantModel | null = null;

/** The configured model, or null when none is (the default). */
export function getCaseAssistantModel(): CaseAssistantModel | null {
  return model;
}

/** Wire in a model adapter (process start-up, or a test). Pass null to remove it. */
export function setCaseAssistantModel(next: CaseAssistantModel | null): void {
  model = next;
}
