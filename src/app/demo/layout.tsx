// /demo (c106) — every demo page carries a persistent, unmissable banner.
import type { Metadata } from "next";
import { DEMO_BANNER } from "@/engines/demo/fixtures";

export const metadata: Metadata = {
  title: "DEMO — Legal Intake Engine walkthrough (fictional data)",
  description: "Guided product demonstration using a fictional demo firm.",
};

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <div
        role="status"
        aria-live="polite"
        className="sticky top-0 z-50 border-b-4 border-amber-500 bg-amber-300 px-4 py-2 text-center text-sm font-bold uppercase tracking-wide text-amber-950"
      >
        {DEMO_BANNER}
      </div>
      <header className="border-b border-slate-200 bg-white px-6 py-3">
        <span className="text-sm font-semibold text-slate-900">Legal Intake Engine — Product demo</span>
      </header>
      <div className="mx-auto max-w-5xl px-6 py-6">{children}</div>
    </div>
  );
}
