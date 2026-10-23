// Admin/staff console (board card c24). Real path segment (/admin/...), not
// a Next.js route group — the URL distinction matters here since this is a
// staff-only surface, separate from the client-facing /chat/... path, and
// eventually sits behind real auth (Clerk/WorkOS, ADR-0001 §D8) once that's
// wired up. `middleware.ts`'s auth stub currently tags every request as
// unauthenticated — do not treat this layout as access-controlled yet.
//
// Espresso & champagne theme: floating espresso sidebar on desktop, a pill
// tab row on tablet, and a floating bottom bar on phones (see AdminNav).
import Link from "next/link";
import { AdminBottomNav, AdminSidebarNav, AdminTabNav } from "./_components/AdminNav";

function ShieldMark({ className, stroke }: { className?: string; stroke: string }) {
  return (
    <svg className={className} viewBox="0 0 30 34" aria-hidden="true">
      <path d="M15 1.5l12 4.5v9.5c0 8-5.2 13.6-12 17-6.8-3.4-12-9-12-17V6z" stroke={stroke} strokeWidth="1.4" fill="none" />
      <path d="M15 9v14M10 13.5h10" stroke={stroke} strokeWidth="1.4" />
    </svg>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 lg:flex lg:gap-4 lg:p-4">
      {/* Desktop: floating espresso sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col rounded-3xl bg-espresso px-3.5 py-6 lg:flex">
        <Link href="/admin" className="mb-6 flex items-center gap-3 px-3">
          <ShieldMark className="h-7 w-6" stroke="#D4B07A" />
          <span className="flex flex-col">
            <span className="font-display text-2xl leading-none text-ivory-bright">Staff Console</span>
            <span className="mt-1 text-xs text-taupe-dim">Legal Intake</span>
          </span>
        </Link>
        <nav aria-label="Staff console">
          <AdminSidebarNav />
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Tablet + phone header */}
        <header className="flex items-center justify-between gap-3 px-4 pt-4 md:px-6 lg:hidden">
          <Link href="/admin" className="flex items-center gap-2.5">
            <ShieldMark className="h-6 w-5" stroke="#7A5524" />
            <span className="font-display text-2xl leading-none text-slate-900">Staff Console</span>
          </Link>
        </header>
        <nav aria-label="Staff console" className="hidden px-4 pt-4 md:block md:px-6 lg:hidden">
          <AdminTabNav />
        </nav>

        <div className="mx-auto max-w-6xl px-4 pb-28 pt-6 md:px-6 md:pb-10 lg:px-6 lg:py-4">{children}</div>
      </div>

      {/* Phone: floating bottom bar */}
      <nav aria-label="Staff console" className="fixed inset-x-3 bottom-3 z-40 md:hidden">
        <AdminBottomNav />
      </nav>
    </div>
  );
}
