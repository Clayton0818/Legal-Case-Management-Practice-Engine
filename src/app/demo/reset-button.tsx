"use client";

// One-click reset of the DEMO firm (c106). The server decides everything:
// it refuses unless this deployment allows demo resets and the signed-in
// session belongs to a flagged demo firm.

import { useState } from "react";

interface ResetResponse {
  newTenantId?: string;
  generation?: number;
  retiredTenantIds?: string[];
  summary?: { ok: number; blocked: number; failed: number };
  error?: string;
}

export function ResetDemoButton({ enabled }: { enabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetResponse | null>(null);

  async function onClick() {
    if (!window.confirm("Reset the DEMO firm? A fresh fictional firm is created and the current one is retired. Real firms are never touched.")) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/demo/reset", { method: "POST" });
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as ResetResponse;
      setResult(res.ok ? body : { error: body.error ?? `HTTP ${res.status}` });
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={!enabled || busy}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {busy ? "Resetting the demo firm…" : "Reset demo firm"}
      </button>
      {!enabled && <p className="text-xs text-slate-500">Reset is switched off on this deployment (DEMO_RESET_ENABLED is not 1).</p>}
      {result?.error && <p className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">Refused: {result.error}</p>}
      {result?.newTenantId && (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">
          <p>
            Fresh demo firm created (generation {result.generation}): <code>{result.newTenantId}</code>. Seed steps: {result.summary?.ok} ok,{" "}
            {result.summary?.blocked} blocked pending review, {result.summary?.failed} failed.
          </p>
          <p className="mt-1">Point the presenter session at the new firm (see “Presenter setup” after reloading), then reload this page.</p>
          <button type="button" className="mt-1 underline" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    </div>
  );
}
