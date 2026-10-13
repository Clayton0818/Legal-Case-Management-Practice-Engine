// Root route: a small launcher for the product's surfaces. The real
// surfaces are the client-facing intake chat (c23), the staff console (c24)
// and the guided product demo on fictional data (c106).
import Link from "next/link";

const TILES = [
  { href: "/admin", title: "Staff console", body: "Matters, intake, conflicts, calendar, documents, trust and operations." },
  { href: "/chat", title: "Intake chat", body: "The client-facing chat a prospect uses to contact the firm." },
  {
    href: "/demo",
    title: "Demo",
    body: "Guided walkthrough of the whole case-management product on a clearly labelled, fictional DEMO firm.",
    badge: "fictional data",
  },
] as const;

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-slate-900">Legal Intake Engine</h1>
      <p className="mt-1 text-sm text-slate-600">
        Health check: <code>/api/health</code>
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {TILES.map((t) => (
          <Link key={t.href} href={t.href} className="block rounded-lg border border-slate-200 bg-white p-5 shadow-sm hover:border-slate-400">
            <span className="flex items-center justify-between">
              <span className="text-base font-semibold text-slate-900">{t.title}</span>
              {"badge" in t && <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold uppercase text-amber-950">{t.badge}</span>}
            </span>
            <span className="mt-2 block text-sm text-slate-600">{t.body}</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
