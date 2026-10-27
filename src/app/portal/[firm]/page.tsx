import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { legalCopyStatus } from "@/compliance/approvals";
import { ALERT_COPY_GATES } from "@/engines/calendar-alerts/gates";
import { PORTAL_COPY_GATES } from "@/portal/gates";
import { liveSessionFor, loadPortalFirm } from "@/portal/http";
import {
  isValidSlug,
  portalPaths,
  portalUrlForFirm,
  toPortalDocumentRequests,
  type PortalDocumentRequest,
} from "@/portal/policy";
import { IDLE_TIMEOUT_MS, PORTAL_COOKIE, readPortalSecret, type PortalSession } from "@/portal/session";
import { IdleGuard } from "../_components/IdleGuard";
import { body, ghostButton, heading, panel, pill, sectionHeading } from "../_components/styles";

// Client portal dashboard (c11, c112): Updates, Your to-dos, Documents we
// need, Your matter. Everything is read inside withTenant(firm) and filtered
// to the signed-in party; only explicitly allow-listed, client-visible
// fields reach the page (src/portal/policy.ts).

export const dynamic = "force-dynamic";

/** c49 checklist items the client owes, per open matter. Kept apart so a missing table never breaks the page. */
async function loadDocumentRequests(session: PortalSession, matterIds: readonly string[]): Promise<PortalDocumentRequest[]> {
  if (matterIds.length === 0) return [];
  try {
    const { withTenant } = await import("@/tenancy/withTenant");
    const { listClientChecklist } = await import("@/engines/document/checklist/service");
    const items = await withTenant(session.tenantId, async (tx) => {
      const all: Awaited<ReturnType<typeof listClientChecklist>> = [];
      for (const matterId of matterIds) all.push(...(await listClientChecklist(tx, session.tenantId, session.partyId, matterId)));
      return all;
    });
    return toPortalDocumentRequests(items);
  } catch (err) {
    // 42P01 = the c49 table is not migrated on this database yet; anything else is worth a log line.
    if ((err as { code?: string } | null)?.code !== "42P01") {
      console.error(
        JSON.stringify({ level: "error", event: "portal.documents.failed", error: err instanceof Error ? err.message : String(err) })
      );
    }
    return [];
  }
}

export default async function PortalHomePage({ params }: { params: Promise<{ firm: string }> }) {
  const { firm: slug } = await params;
  if (!isValidSlug(slug)) notFound();
  const paths = portalPaths(slug);
  const secret = readPortalSecret(process.env);
  if (!secret.ok) redirect(`${paths.signIn}?error=unavailable`);
  const firm = await loadPortalFirm(slug);
  if (!firm) notFound();

  const store = await cookies();
  const { session, hadCookie } = await liveSessionFor(firm.id, store.get(PORTAL_COOKIE)?.value, secret.secret, Date.now());
  if (!session) redirect(hadCookie ? `${paths.signIn}?expired=1` : paths.signIn);

  const { ensureServerApprovals } = await import("@/compliance/server");
  await ensureServerApprovals();
  const { withTenant } = await import("@/tenancy/withTenant");
  const { loadPortalHome } = await import("@/portal/service");
  const home = await withTenant(firm.id, (tx) =>
    loadPortalHome(tx, session, { firmName: firm.name, portalUrl: portalUrlForFirm(process.env.PORTAL_BASE_URL, slug) })
  );
  const documents = await loadDocumentRequests(session, home.matters.map((m) => m.id));

  const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: home.timeZone });
  const dateOnly = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: home.timeZone });
  const pastDueLabel = legalCopyStatus(ALERT_COPY_GATES.portalPastDueLabel.key).text;
  const unread = home.updates.filter((u) => !u.read).length;

  return (
    <div className="space-y-5">
      <IdleGuard expiredPath={`${paths.signIn}?expired=1`} idleMs={IDLE_TIMEOUT_MS} />

      <section className={panel} aria-labelledby="portal-welcome">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 id="portal-welcome" className={heading}>
              Your portal
            </h1>
            <p className={`mt-2 ${body}`}>
              {unread > 0 ? `You have ${unread} new ${unread === 1 ? "update" : "updates"}.` : "You are all caught up."}
            </p>
          </div>
          <form method="post" action="/api/portal/sign-out" className="flex flex-col items-start gap-1">
            <input type="hidden" name="firm" value={slug} />
            <button type="submit" className={ghostButton}>
              Sign out
            </button>
            <span className="pl-2 text-xs text-taupe-faint">Signs you out on every device</span>
          </form>
        </div>
      </section>

      <section id="updates" className={panel} aria-labelledby="portal-updates">
        <h2 id="portal-updates" className={sectionHeading}>
          Updates
        </h2>
        {home.updates.length === 0 ? (
          <p className={`mt-3 ${body}`}>No updates yet.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {home.updates.map((u) => (
              <li key={u.id} className="rounded-2xl bg-espresso-bubble px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {!u.read && <span className={`${pill} bg-champagne/15 text-champagne-light`}>New</span>}
                  <time dateTime={u.createdAt.toISOString()} className="text-xs text-taupe-dim">
                    {dateTime.format(u.createdAt)}
                  </time>
                </div>
                <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-ivory-text">{u.message}</p>
                {!u.read && (
                  <form method="post" action="/api/portal/notifications/read" className="mt-2">
                    <input type="hidden" name="firm" value={slug} />
                    <input type="hidden" name="id" value={u.id} />
                    <button type="submit" className="inline-flex min-h-11 items-center text-sm font-semibold text-champagne hover:text-champagne-light">
                      Mark as read
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={panel} aria-labelledby="portal-todos">
        <h2 id="portal-todos" className={sectionHeading}>
          Your to-dos
        </h2>
        {home.todos.length === 0 ? (
          <p className={`mt-3 ${body}`}>Nothing to do right now.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {home.todos.map((t) => (
              <li key={t.id} className="rounded-2xl bg-espresso-bubble px-4 py-3">
                <p className="text-[15px] font-semibold text-ivory-bright">{t.title}</p>
                {t.description && <p className="mt-1 text-sm leading-relaxed text-taupe">{t.description}</p>}
                <p className="mt-2 text-xs text-taupe-dim">
                  Please complete by <time dateTime={t.dueAt.toISOString()}>{dateTime.format(t.dueAt)}</time>
                </p>
                {t.pastDue && <p className={`mt-2 ${pill} bg-white/5 text-champagne-light`}>{pastDueLabel}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={panel} aria-labelledby="portal-documents">
        <h2 id="portal-documents" className={sectionHeading}>
          Documents we need
        </h2>
        <p className={`mt-2 ${body}`}>{legalCopyStatus(PORTAL_COPY_GATES.documentsIntro.key).text}</p>
        {documents.length === 0 ? (
          <p className={`mt-3 ${body}`}>Nothing requested right now.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-espresso-bubble px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold text-ivory-bright">{d.label}</p>
                  {d.description && <p className="mt-1 text-sm leading-relaxed text-taupe">{d.description}</p>}
                </div>
                <span className={`${pill} bg-white/5 text-taupe`}>{d.statusLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={panel} aria-labelledby="portal-matter">
        <h2 id="portal-matter" className={sectionHeading}>
          Your matter
        </h2>
        <ul className="mt-4 space-y-3">
          {home.matters.map((m) => (
            <li key={m.id} className="rounded-2xl bg-espresso-bubble px-4 py-3">
              <p className="text-[15px] leading-relaxed text-ivory-text">{legalCopyStatus(PORTAL_COPY_GATES.matterOpen.key).text}</p>
              <p className="mt-1 text-xs text-taupe-dim">
                Opened <time dateTime={m.openedAt.toISOString()}>{dateOnly.format(m.openedAt)}</time>
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
