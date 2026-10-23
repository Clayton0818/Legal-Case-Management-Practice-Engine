// /demo (c106) — every demo page carries a persistent, unmissable banner.
import type { Metadata } from "next";
import Link from "next/link";
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
      <header className="bg-espresso-deep">
        <div className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-4 px-4 py-8 md:px-6 md:py-10">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 py-1.5 pl-2.5 pr-3.5 text-xs font-medium text-taupe">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-champagne" />
              Product demo
            </span>
            <p className="mt-3 font-display text-4xl leading-none tracking-tight text-ivory-bright md:text-5xl">
              Legal Intake <span className="italic text-champagne">Engine</span>
            </p>
          </div>
          <Link
            href="/admin"
            className="inline-flex min-h-[44px] items-center rounded-full border border-champagne/50 px-5 text-sm font-medium text-ivory-text hover:bg-champagne/10"
          >
            Staff console →
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">{children}</div>
    </div>
  );
}
