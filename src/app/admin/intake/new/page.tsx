// c122 — "New intake": a staff member (an attorney, intake staff or a firm
// admin) enters someone who reached the firm outside the intake team's
// channels: a walk-in, a call on a lawyer's own phone, or a referral.
// Internal only. The form checks for an existing record first, so an
// intake the team already has is picked up instead of duplicated.
import Link from "next/link";
import { NEW_INTAKE_CHANNELS, NEW_INTAKE_CHANNEL_LABEL } from "@/engines/intake/staffEntry/steps";
import { Notice, PageHeader } from "../../_components/ui";
import { NewIntakeForm } from "./new-intake-form";

export const dynamic = "force-dynamic";

export default function NewIntakePage() {
  const channels = NEW_INTAKE_CHANNELS.map((value) => ({ value, label: NEW_INTAKE_CHANNEL_LABEL[value] }));
  return (
    <div className="space-y-6">
      <Link href="/admin/intake" className="text-sm text-slate-500 hover:underline">
        ← Back to the intake queue
      </Link>
      <PageHeader
        eyebrow="Client intake"
        title="New intake"
        description="For someone who reached the firm outside the usual channels: a walk-in, a call on a lawyer's own phone, or a referral. It goes through the same steps as every other inquiry."
      />
      <Notice tone="info">
        Collect only contact details here. Case details come later, once the disclosures are read and the conflict check is clear.
      </Notice>
      <NewIntakeForm channels={channels} />
    </div>
  );
}
