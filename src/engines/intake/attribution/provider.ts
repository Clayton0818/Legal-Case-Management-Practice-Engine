// c74 — phone-tracking-number resolution. Recording the number a caller
// dialed (intake_lead_attribution.phoneTrackingNumber) needs no vendor at
// all — the number arrives with the inbound call/webhook and is just
// stored. RESOLVING which marketing campaign a tracking number maps to —
// the thing an actual call-tracking vendor (e.g. CallRail, CallTrackingMetrics)
// would do — is a vendor integration, and per src/engines/README.md's
// approval-placeholder table, vendor calls are gated and go through a stub
// adapter rather than being hard-coded.
//
// This reuses the shared `voice` gate (src/compliance/gates.ts
// VENDOR_GATES.voice — "Phone / call-recording provider") instead of
// defining a second telephony gate: a tracking-number provider and a
// call-recording provider are both "the firm's phone vendor" from a DPA
// standpoint, and README says not to define a second gate for the same
// vendor. If the real vendor turns out to need its own DPA review, that's
// a one-line addition to VENDOR_GATES, not a reason to skip gating here.
//
// No adapter is wired to a real vendor by this card — see
// docs/go-to-market/lead-source-attribution.md's open questions. This file
// exists so a future integration has the gate and the interface already in
// place instead of a vendor call being hard-coded directly into capture.

import { runGated, type GatedResult } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";

export interface PhoneTrackingLookup {
  /** The campaign/source the vendor says this tracking number belongs to. */
  campaignTag: string | null;
  sourceLabel: string | null;
}

export interface PhoneTrackingProvider {
  resolveTrackingNumber(trackingNumber: string): Promise<PhoneTrackingLookup | null>;
}

/**
 * No vendor call. The tracking number is still recorded (see
 * src/engines/intake/attribution/service.ts) — only the CAMPAIGN lookup is
 * unavailable until a real provider is approved and wired in here.
 */
export const stubPhoneTrackingProvider: PhoneTrackingProvider = {
  async resolveTrackingNumber() {
    return null;
  },
};

/**
 * Resolve a tracking number to a campaign through `provider`, gated on
 * vendor.voice. Returns the gate's blocked result (never throws) so a
 * report can show "source: phone tracking (campaign unresolved — vendor
 * pending)" instead of failing.
 */
export async function resolveTrackingNumberGated(
  tenantId: string,
  trackingNumber: string,
  provider: PhoneTrackingProvider = stubPhoneTrackingProvider
): Promise<GatedResult<PhoneTrackingLookup | null>> {
  return runGated(VENDOR_GATES.voice.key, "intake.attribution.resolve_tracking_number", () => provider.resolveTrackingNumber(trackingNumber), {
    tenantId,
  });
}
