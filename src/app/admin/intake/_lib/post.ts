"use client";

// Small fetch helper for the intake console's client components (c122).
// Every write goes through the /api/intake/staff/** routes, which re-check
// the signed-in staff member and the engine's rules server-side.
export async function postJson<T>(url: string, body: unknown): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
    if (res.ok) return { data: json, error: null };
    return { data: null, error: json?.error ?? json?.message ?? `Something went wrong (HTTP ${res.status}).` };
  } catch {
    return { data: null, error: "Couldn't reach the server. Check your connection and try again." };
  }
}
