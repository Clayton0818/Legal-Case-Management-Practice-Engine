import { notFound } from "next/navigation";
import { resolveAuthConfig } from "@/auth/config";
import { legalCopyStatus } from "@/compliance/approvals";
import { isWellFormedToken } from "@/portal/crypto";
import { PORTAL_COPY_GATES } from "@/portal/gates";
import { loadPortalFirm } from "@/portal/http";
import { isValidSlug, linkOnScreenAllowed, portalPaths, SIGN_IN_TOKEN_TTL_MINUTES } from "@/portal/policy";
import { body, errorNotice, heading, notice, panel, primaryButton } from "../../_components/styles";

// Client portal sign-in (c11): passwordless, one-time link by email.
// Every outcome shows the same neutral confirmation (no account enumeration).

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function PortalSignIn({ params, searchParams }: { params: Promise<{ firm: string }>; searchParams: Promise<Search> }) {
  const { firm: slug } = await params;
  const q = await searchParams;
  if (!isValidSlug(slug)) notFound();
  const firm = await loadPortalFirm(slug);
  if (!firm) notFound();
  const { ensureServerApprovals } = await import("@/compliance/server");
  await ensureServerApprovals();

  const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
  const sent = one("sent") === "1";
  const dev = one("dev");
  const devLink =
    sent && isWellFormedToken(dev) && linkOnScreenAllowed(resolveAuthConfig(process.env).mode, firm.isProduction)
      ? portalPaths(slug).verify(dev)
      : null;
  const minutes = SIGN_IN_TOKEN_TTL_MINUTES;

  return (
    <section className={panel} aria-labelledby="portal-sign-in">
      <h1 id="portal-sign-in" className={heading}>
        Sign in
      </h1>
      <p className={`mt-3 ${body}`}>{legalCopyStatus(PORTAL_COPY_GATES.signInIntro.key).text}</p>

      <div className="mt-5 space-y-3" aria-live="polite">
        {sent && (
          <p role="status" className={notice}>
            {legalCopyStatus(PORTAL_COPY_GATES.linkSent.key, { minutes }).text}
          </p>
        )}
        {(one("expired") === "1" || one("signedOut") === "1") && (
          <p role="status" className={notice}>
            {one("signedOut") === "1" ? "You have been signed out on every device." : legalCopyStatus(PORTAL_COPY_GATES.linkExpired.key).text}
          </p>
        )}
        {one("error") === "email" && (
          <p role="alert" className={errorNotice}>
            Please enter a complete email address.
          </p>
        )}
        {one("error") === "unavailable" && (
          <p role="alert" className={errorNotice}>
            The portal is not available right now. Please contact your legal team.
          </p>
        )}
        {devLink && (
          <div role="note" className="rounded-2xl border border-dashed border-champagne/60 px-4 py-3 text-sm text-ivory-text">
            <p className="font-semibold text-champagne-light">DEV / DEMO ONLY — never shown with real sign-in.</p>
            <p className="mt-1 text-taupe">In a live firm this link is only emailed to the client&apos;s safe address.</p>
            <a href={devLink} className="mt-2 inline-flex min-h-11 items-center font-semibold text-champagne underline underline-offset-4">
              Open the one-time sign-in link
            </a>
          </div>
        )}
      </div>

      <form method="post" action="/api/portal/sign-in" className="mt-6 flex flex-col gap-2">
        <input type="hidden" name="firm" value={slug} />
        <label htmlFor="portal-email" className="pl-2 text-xs font-medium text-taupe-dim">
          Email address
        </label>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            id="portal-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            className="h-12 min-w-0 flex-1 rounded-full border border-white/10 bg-espresso-deep px-5 text-base text-ivory placeholder:text-taupe-faint"
            placeholder="you@example.com"
          />
          <button type="submit" className={primaryButton}>
            Email me a link
          </button>
        </div>
      </form>
    </section>
  );
}
