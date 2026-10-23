"use client";

// Staff console navigation (espresso & champagne theme). Three shapes from
// one list:
//   - desktop (lg+): links inside the floating espresso sidebar
//   - tablet (md–lg): a horizontally scrolling row of pills
//   - phone (<md): a floating rounded bar at the bottom with the first three
//     sections plus "More", which opens the full list
// Client component only because the active state needs usePathname().
import Link from "next/link";
import { usePathname } from "next/navigation";

const ADMIN_NAV = [
  { href: "/admin", label: "Matters" },
  { href: "/admin/intake", label: "Intake" },
  { href: "/admin/conflict-check", label: "Conflicts" },
  { href: "/admin/calendar-core", label: "Calendar" },
  { href: "/admin/calendar-alerts", label: "Client alerts" },
  { href: "/admin/document", label: "Documents" },
  { href: "/admin/billing-trust", label: "Trust & billing" },
  { href: "/admin/insights", label: "Insights" },
  { href: "/admin/all-engines", label: "Settings" },
  { href: "/admin/ops", label: "Operations" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin" || pathname.startsWith("/admin/matters");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminSidebarNav() {
  const pathname = usePathname() ?? "";
  return (
    <ul className="flex flex-col gap-1">
      {ADMIN_NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "block rounded-xl bg-champagne/15 px-3.5 py-3 text-sm font-semibold text-champagne-light"
                  : "block rounded-xl px-3.5 py-3 text-sm font-medium text-taupe transition hover:bg-white/5 hover:text-ivory-text"
              }
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function AdminTabNav() {
  const pathname = usePathname() ?? "";
  return (
    <ul className="flex gap-1.5 overflow-x-auto pb-1">
      {ADMIN_NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href} className="shrink-0">
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "block whitespace-nowrap rounded-full bg-espresso px-4 py-2.5 text-sm font-semibold text-champagne-light"
                  : "block whitespace-nowrap rounded-full bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:text-slate-900"
              }
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function AdminBottomNav() {
  const pathname = usePathname() ?? "";
  const primary = ADMIN_NAV.slice(0, 3);
  const moreActive = ADMIN_NAV.slice(3).some((item) => isActive(pathname, item.href));
  return (
    <div className="grid grid-cols-4 gap-1 rounded-full bg-espresso p-1.5 shadow-lg shadow-black/20">
      {primary.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "flex min-h-[48px] items-center justify-center rounded-full bg-champagne/15 px-2 text-xs font-semibold text-champagne-light"
                : "flex min-h-[48px] items-center justify-center rounded-full px-2 text-xs font-medium text-taupe"
            }
          >
            {item.label}
          </Link>
        );
      })}
      <details className="group relative">
        <summary
          className={
            moreActive
              ? "flex min-h-[48px] cursor-pointer list-none items-center justify-center rounded-full bg-champagne/15 px-2 text-xs font-semibold text-champagne-light [&::-webkit-details-marker]:hidden"
              : "flex min-h-[48px] cursor-pointer list-none items-center justify-center rounded-full px-2 text-xs font-medium text-taupe [&::-webkit-details-marker]:hidden"
          }
        >
          More
        </summary>
        <ul className="absolute bottom-full right-0 mb-3 w-56 rounded-2xl bg-espresso p-2 shadow-xl shadow-black/30">
          {ADMIN_NAV.slice(3).map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "block rounded-xl bg-champagne/15 px-3.5 py-3 text-sm font-semibold text-champagne-light"
                      : "block rounded-xl px-3.5 py-3 text-sm font-medium text-taupe hover:bg-white/5 hover:text-ivory-text"
                  }
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
