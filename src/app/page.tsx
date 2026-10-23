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
    <main className="min-h-screen bg-espresso-deep text-ivory-text">
      <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-20">
        <span className="inline-flex items-center gap-2.5 rounded-full border border-white/10 py-2 pl-3 pr-4 text-sm font-medium text-taupe">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-champagne" />
          Case management
        </span>
        <h1 className="mt-6 font-display text-5xl leading-none tracking-tight text-ivory-bright sm:text-7xl">
          Legal Intake <span className="italic text-champagne">Engine</span>
        </h1>
        <p className="mt-4 text-sm text-taupe-dim">
          Health check: <code className="rounded bg-white/5 px-1.5 py-0.5 text-taupe">/api/health</code>
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {TILES.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="group flex flex-col rounded-3xl border border-white/10 bg-espresso-panel p-6 transition hover:border-champagne/50"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="font-display text-3xl text-ivory-bright">{t.title}</span>
                {"badge" in t && (
                  <span className="rounded-full bg-champagne/15 px-2.5 py-1 text-xs font-semibold text-champagne-light">{t.badge}</span>
                )}
              </span>
              <span className="mt-3 block text-sm leading-relaxed text-taupe">{t.body}</span>
              <span aria-hidden="true" className="mt-6 text-sm font-semibold text-champagne group-hover:text-champagne-light">
                Open →
              </span>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
