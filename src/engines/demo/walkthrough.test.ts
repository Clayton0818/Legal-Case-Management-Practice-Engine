import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { hasGate, resetApprovalStateForTests, setApprovals } from "@/compliance/approvals";
import { loadAllGates } from "@/compliance/allGates";
import { FORBIDDEN_CLAIMS, WALKTHROUGH, resolveHref, stepText } from "./walkthrough";
import { HONESTY_STATEMENT, gateView, simulatedLabel } from "./honesty";

const APP = path.resolve(__dirname, "../../app");

/** Find the app file serving `href` (dynamic [segments] match any value). */
function routeFileFor(href: string, kind: "page" | "api"): string | null {
  const parts = href.split("?")[0]!.split("/").filter(Boolean);
  const file = kind === "api" ? "route.ts" : "page.tsx";
  const walk = (dir: string, i: number): string | null => {
    if (i === parts.length) {
      const f = path.join(dir, file);
      return existsSync(f) ? f : null;
    }
    const exact = path.join(dir, parts[i]!);
    if (existsSync(exact)) {
      const r = walk(exact, i + 1);
      if (r) return r;
    }
    for (const name of ["[id]", "[matterId]", "[area]", "[txId]", "[userId]"]) {
      const dyn = path.join(dir, name);
      if (existsSync(dyn)) {
        const r = walk(dyn, i + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(APP, 0);
}

const ids = {
  matter: { sampleford: "00000000-0000-4000-8000-000000000001", fictiva: "00000000-0000-4000-8000-000000000002", placewell: "00000000-0000-4000-8000-000000000003" },
  session: { clear: "00000000-0000-4000-8000-000000000004" },
};

describe("the guided walkthrough", () => {
  beforeAll(async () => {
    await loadAllGates();
  });

  it("covers the whole journey, in order", () => {
    expect(WALKTHROUGH.map((s) => s.id)).toEqual([
      "chat-in",
      "triage-emergency",
      "conflicts",
      "booking",
      "acceptance",
      "opening",
      "calendar",
      "limitations",
      "documents",
      "trust",
      "communication",
      "court-notice",
      "health",
      "permissions",
      "family-pack",
      "ops",
    ]);
    expect(new Set(WALKTHROUGH.map((s) => s.id)).size).toBe(WALKTHROUGH.length);
  });

  it("every step has an explanation, a link into the product and talking points", () => {
    for (const s of WALKTHROUGH) {
      expect(s.explanation.length, s.id).toBeGreaterThan(60);
      expect(s.links.length, s.id).toBeGreaterThan(0);
      expect(s.links.some((l) => l.kind === "page"), `${s.id} needs a real page link`).toBe(true);
      expect(s.talkingPoints.length, s.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("every link points at a page or GET route that exists", () => {
    for (const s of WALKTHROUGH) {
      for (const l of s.links) {
        const href = resolveHref(l.href, ids);
        expect(href, `${s.id}: ${l.href}`).not.toBeNull();
        const f = routeFileFor(href!, l.kind);
        expect(f, `${s.id}: ${l.href} has no ${l.kind === "api" ? "route.ts" : "page.tsx"}`).not.toBeNull();
        if (l.kind === "api") expect(readFileSync(f!, "utf8"), `${l.href} must answer GET`).toMatch(/export (async )?function GET/);
      }
    }
  });

  it("every gate it shows exists, and a pending gate shows its visible placeholder", () => {
    resetApprovalStateForTests();
    setApprovals([]);
    for (const s of WALKTHROUGH) {
      for (const key of s.gates) {
        expect(hasGate(key), `${s.id}: unknown gate ${key}`).toBe(true);
        const v = gateView(key);
        expect(v.approved).toBe(false);
        expect(v.placeholder).toMatch(/^\[PENDING [A-Z +_]+ REVIEW — .*\(gate: /);
        expect(v.label).toMatch(/^Pending /);
      }
    }
    resetApprovalStateForTests();
  });

  it("steps that depend on attorney / CPA sign-off list their gates", () => {
    const gatesOf = (id: string) => WALKTHROUGH.find((s) => s.id === id)!.gates;
    expect(gatesOf("trust")).toContain("rules.trust_accounting");
    expect(gatesOf("calendar")).toContain("rules.court_deadlines");
    expect(gatesOf("conflicts")).toContain("rules.conflicts");
    expect(gatesOf("opening")).toContain("rules.intake.matter_open_gates");
    expect(gatesOf("limitations")).toContain("rules.limitation_periods");
  });

  it("marks the vendor stubs as simulated", () => {
    const simulated = new Set(WALKTHROUGH.flatMap((s) => s.simulated));
    for (const v of ["email", "calendar sync", "document storage", "OCR", "bank feed"] as const) expect(simulated.has(v), v).toBe(true);
    expect(simulatedLabel("bank feed")).toBe("bank feed — simulated in demo");
  });

  it("never implies the AI gives legal advice, decides deadlines or clears conflicts", () => {
    const texts = [...WALKTHROUGH.flatMap(stepText), ...HONESTY_STATEMENT];
    for (const t of texts) for (const re of FORBIDDEN_CLAIMS) expect(t, `"${t}" matches ${re}`).not.toMatch(re);
    // …and says the opposite plainly, more than once.
    const all = texts.join(" ");
    expect(all).toMatch(/does not give legal advice/);
    expect(all).toMatch(/never clears a conflict|Nothing is ever cleared automatically/);
    expect(all).toMatch(/never decides a deadline|does not decide deadlines/);
  });

  it("the forbidden-phrase list actually catches the bad claims", () => {
    const bad = ["Our AI gives legal advice to callers.", "The system decides deadlines for you.", "The assistant clears conflicts instantly.", "It will automatically clear the conflict."];
    for (const b of bad) expect(FORBIDDEN_CLAIMS.some((re) => re.test(b)), b).toBe(true);
  });

  it("fills link tokens from the live demo firm, or disables the link", () => {
    expect(resolveHref("/admin/matters/{matter:placewell}", ids)).toBe(`/admin/matters/${ids.matter.placewell}`);
    expect(resolveHref("/admin/matters/{matter:unknown}", ids)).toBeNull();
    expect(resolveHref("/admin", ids)).toBe("/admin");
  });
});
