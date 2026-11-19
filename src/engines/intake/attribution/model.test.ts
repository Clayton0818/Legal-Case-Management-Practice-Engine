import { describe, expect, it } from "vitest";
import {
  deriveAttributionSource,
  describeAttributionSource,
  normalizeLeadAttributionInput,
  normalizeTrackingNumber,
  type LeadAttributionRecord,
} from "./model";

const EMPTY: LeadAttributionRecord = {
  landingPage: null,
  campaignTag: null,
  isGoogleAds: false,
  directoryName: null,
  referralSource: null,
  phoneTrackingNumber: null,
};

describe("normalizeTrackingNumber", () => {
  it("strips formatting but keeps digits and a leading +", () => {
    expect(normalizeTrackingNumber("+1 (512) 555-0134")).toBe("+15125550134");
  });

  it("returns null for blank input", () => {
    expect(normalizeTrackingNumber("   ")).toBeNull();
    expect(normalizeTrackingNumber(null)).toBeNull();
    expect(normalizeTrackingNumber(undefined)).toBeNull();
  });
});

describe("normalizeLeadAttributionInput", () => {
  it("trims blanks to null and never throws on empty input", () => {
    expect(normalizeLeadAttributionInput({})).toEqual(EMPTY);
    expect(normalizeLeadAttributionInput({ landingPage: "   ", directoryName: "" })).toEqual(EMPTY);
  });

  it("keeps real values and coerces isGoogleAds to a strict boolean", () => {
    expect(
      normalizeLeadAttributionInput({
        landingPage: " /family-law ",
        campaignTag: "spring_divorce_2026",
        isGoogleAds: true,
        phoneTrackingNumber: "512-555-0134",
      })
    ).toEqual({
      landingPage: "/family-law",
      campaignTag: "spring_divorce_2026",
      isGoogleAds: true,
      directoryName: null,
      referralSource: null,
      phoneTrackingNumber: "5125550134",
    });
  });
});

describe("deriveAttributionSource", () => {
  it("returns 'unknown' for null or fully-empty attribution", () => {
    expect(deriveAttributionSource(null)).toBe("unknown");
    expect(deriveAttributionSource(EMPTY)).toBe("unknown");
  });

  it("prioritises google ads over every other signal", () => {
    expect(
      deriveAttributionSource({
        ...EMPTY,
        isGoogleAds: true,
        directoryName: "Avvo",
        referralSource: "Past client",
        landingPage: "/family-law",
      })
    ).toBe("google_ads");
  });

  it("prioritises phone tracking over directory and referral", () => {
    expect(deriveAttributionSource({ ...EMPTY, phoneTrackingNumber: "+15125550134", directoryName: "Avvo" })).toBe("phone_tracking");
  });

  it("prioritises directory over referral", () => {
    expect(deriveAttributionSource({ ...EMPTY, directoryName: "Avvo", referralSource: "Past client" })).toBe("directory");
  });

  it("falls back to referral, then website, then other", () => {
    expect(deriveAttributionSource({ ...EMPTY, referralSource: "Past client" })).toBe("referral");
    expect(deriveAttributionSource({ ...EMPTY, landingPage: "/family-law" })).toBe("website");
    expect(deriveAttributionSource({ ...EMPTY, campaignTag: "spring_divorce_2026" })).toBe("website");
  });
});

describe("describeAttributionSource", () => {
  it("folds the directory/referral/campaign name into the label", () => {
    expect(describeAttributionSource({ ...EMPTY, directoryName: "Avvo" })).toBe("Directory: Avvo");
    expect(describeAttributionSource({ ...EMPTY, referralSource: "Past client" })).toBe("Referral: Past client");
    expect(describeAttributionSource({ ...EMPTY, campaignTag: "spring_divorce_2026" })).toBe("Website: spring_divorce_2026");
  });

  it("labels the remaining buckets plainly", () => {
    expect(describeAttributionSource({ ...EMPTY, isGoogleAds: true })).toBe("Google Ads");
    expect(describeAttributionSource({ ...EMPTY, phoneTrackingNumber: "+15125550134" })).toBe("Phone tracking number");
    expect(describeAttributionSource({ ...EMPTY, landingPage: "/family-law" })).toBe("Website (organic)");
    expect(describeAttributionSource(EMPTY)).toBe("Unknown");
  });
});
