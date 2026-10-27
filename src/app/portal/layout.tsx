import type { Metadata } from "next";
import { legalCopyStatus } from "@/compliance/approvals";
import { PORTAL_COPY_GATES } from "@/portal/gates";
import { QUICK_EXIT_URL } from "@/portal/policy";
import { QuickExit } from "./_components/QuickExit";

// Client portal (c11, c112). DV safety: a neutral tab title, no firm name,
// matter or case detail in the title or header, no indexing, no referrer,
// and a Quick exit button on every page.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Secure portal",
  description: "Secure portal",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { ensureServerApprovals } = await import("@/compliance/server");
  await ensureServerApprovals();
  const exitHelp = legalCopyStatus(PORTAL_COPY_GATES.quickExitHelp.key).text;
  return (
    <div className="flex min-h-[100dvh] flex-col bg-espresso-deep text-ivory-text">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-4 sm:px-6 sm:py-6">
        <span className="flex items-center gap-2.5">
          <svg width="22" height="26" viewBox="0 0 30 34" aria-hidden="true">
            <path d="M15 1.5l12 4.5v9.5c0 8-5.2 13.6-12 17-6.8-3.4-12-9-12-17V6z" stroke="#D4B07A" strokeWidth="1.4" fill="none" />
            <path d="M11 17l3 3 6-6" stroke="#D4B07A" strokeWidth="1.4" fill="none" />
          </svg>
          <span className="font-display text-2xl text-ivory-bright">Secure portal</span>
        </span>
        <QuickExit exitUrl={QUICK_EXIT_URL} />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-10 sm:px-6">{children}</main>
      <footer className="mx-auto w-full max-w-3xl px-4 pb-8 sm:px-6">
        <p className="text-xs leading-relaxed text-taupe-faint">{exitHelp}</p>
      </footer>
    </div>
  );
}
