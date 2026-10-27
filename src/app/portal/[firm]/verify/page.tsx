import Link from "next/link";
import { notFound } from "next/navigation";
import { legalCopyStatus } from "@/compliance/approvals";
import { isWellFormedToken } from "@/portal/crypto";
import { PORTAL_COPY_GATES } from "@/portal/gates";
import { isValidSlug, portalPaths } from "@/portal/policy";
import { body, ghostButton, heading, notice, panel, primaryButton } from "../../_components/styles";

// Landing page for the emailed one-time link (c11). Opening it does NOT sign
// in — the button POSTs the token — so email link-scanners that pre-open
// links cannot use up the client's link. The token never appears in a
// referrer (referrer-policy: no-referrer on every portal response).

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function PortalVerify({ params, searchParams }: { params: Promise<{ firm: string }>; searchParams: Promise<Search> }) {
  const { firm: slug } = await params;
  const q = await searchParams;
  if (!isValidSlug(slug)) notFound();
  const token = typeof q.token === "string" ? q.token : undefined;
  const paths = portalPaths(slug);
  const { ensureServerApprovals } = await import("@/compliance/server");
  await ensureServerApprovals();

  if (!isWellFormedToken(token)) {
    return (
      <section className={panel}>
        <h1 className={heading}>Sign in</h1>
        <p role="status" className={`mt-4 ${notice}`}>
          {legalCopyStatus(PORTAL_COPY_GATES.linkExpired.key).text}
        </p>
        <Link href={paths.signIn} className={`mt-6 ${ghostButton}`}>
          Get a new link
        </Link>
      </section>
    );
  }

  return (
    <section className={panel}>
      <h1 className={heading}>Welcome back</h1>
      <p className={`mt-3 ${body}`}>For your security, each sign-in link works only once.</p>
      <form method="post" action="/api/portal/verify" className="mt-6">
        <input type="hidden" name="firm" value={slug} />
        <input type="hidden" name="token" value={token} />
        <button type="submit" className={primaryButton}>
          Continue to your portal
        </button>
      </form>
    </section>
  );
}
