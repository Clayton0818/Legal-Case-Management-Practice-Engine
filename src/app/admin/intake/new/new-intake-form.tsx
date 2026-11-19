"use client";

// c122 — the "New intake" and "Record a referral" forms. Step 1 always looks
// for an existing record (name, email or phone) so staff pick up an open
// intake instead of creating a duplicate; step 2 creates the intake and opens
// its guided page. A referral sends nothing to the referred person (c65).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../_lib/post";

interface ChannelOption {
  value: string;
  label: string;
}

interface Match {
  partyId: string;
  fullName: string;
  matchedOn: string[];
  openIntakes: Array<{ intakeSessionId: string; channel: string; status: string; startedAt: string }>;
}

const INPUT = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none";
const LABEL = "block text-sm font-medium text-slate-700";
const BUTTON = "rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";
const BUTTON_SECONDARY = "rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 disabled:opacity-50";

function label(value: string): string {
  return value.replace(/_/g, " ");
}

export function NewIntakeForm({ channels }: { channels: ChannelOption[] }) {
  const [mode, setMode] = useState<"intake" | "referral">("intake");
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="What are you entering?" className="flex gap-2">
        <button type="button" role="tab" aria-selected={mode === "intake"} onClick={() => setMode("intake")} className={mode === "intake" ? BUTTON : BUTTON_SECONDARY}>
          Walk-in or call
        </button>
        <button type="button" role="tab" aria-selected={mode === "referral"} onClick={() => setMode("referral")} className={mode === "referral" ? BUTTON : BUTTON_SECONDARY}>
          Referral
        </button>
      </div>
      {mode === "intake" ? <IntakeForm channels={channels} /> : <ReferralForm />}
    </div>
  );
}

function IntakeForm({ channels }: { channels: ChannelOption[] }) {
  const router = useRouter();
  const [channel, setChannel] = useState(channels[0]?.value ?? "walk_in");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [language, setLanguage] = useState("en");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Any change to the contact details means the lookup has to run again.
  function edit(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      setMatches(null);
    };
  }

  async function lookUp() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await postJson<{ matches: Match[] }>("/api/intake/staff/lookup", { name, email, phone });
    setBusy(false);
    if (err) return setError(err);
    setMatches(data?.matches ?? []);
  }

  async function create() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await postJson<{ intakeSessionId: string }>("/api/intake/staff/intakes", { channel, name, email, phone, language });
    if (err || !data) {
      setBusy(false);
      return setError(err ?? "The intake wasn't created.");
    }
    router.push(`/admin/intake/${data.intakeSessionId}`);
  }

  const canLookUp = name.trim().length > 0 && (phone.trim().length > 0 || email.trim().length > 0);

  return (
    <form
      className="glass-card space-y-4 rounded-[1.25rem] p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (matches === null) void lookUp();
      }}
    >
      <fieldset className="space-y-2">
        <legend className={LABEL}>How did they reach the firm?</legend>
        {channels.map((c) => (
          <label key={c.value} className="flex items-center gap-2 text-sm text-slate-800">
            <input type="radio" name="channel" value={c.value} checked={channel === c.value} onChange={() => setChannel(c.value)} />
            {c.label}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 sm:col-span-2">
          <span className={LABEL}>Full name</span>
          <input className={INPUT} value={name} onChange={edit(setName)} autoComplete="off" required />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Phone</span>
          <input className={INPUT} value={phone} onChange={edit(setPhone)} inputMode="tel" autoComplete="off" />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Email</span>
          <input className={INPUT} value={email} onChange={edit(setEmail)} type="email" autoComplete="off" />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Language</span>
          <select className={INPUT} value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">English</option>
            <option value="es">Spanish</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-slate-500">A phone number or an email address is needed so the firm can reach them.</p>

      {error ? (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {matches === null ? (
        <button type="submit" disabled={busy || !canLookUp} className={BUTTON}>
          {busy ? "Checking…" : "Check for an existing record"}
        </button>
      ) : (
        <div className="space-y-3">
          {matches.length === 0 ? (
            <p className="text-sm text-slate-700">No existing record matches these details.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-800">The firm may already have this person. Open their intake instead of creating a new one:</p>
              <ul className="space-y-2">
                {matches.map((m) => (
                  <li key={m.partyId} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
                    <p className="font-semibold text-slate-900">
                      {m.fullName} <span className="font-normal text-slate-500">· matched on {m.matchedOn.join(", ")}</span>
                    </p>
                    {m.openIntakes.length === 0 ? (
                      <p className="mt-1 text-slate-600">No open intake. Create a new one below if this is a new inquiry.</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {m.openIntakes.map((o) => (
                          <li key={o.intakeSessionId}>
                            <Link href={`/admin/intake/${o.intakeSessionId}`} className="text-indigo-700 hover:underline">
                              Open intake ({label(o.channel)}, {label(o.status)}, started {new Date(o.startedAt).toLocaleDateString("en-US")})
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" disabled={busy} onClick={() => void create()} className={BUTTON}>
            {busy ? "Creating…" : matches.length === 0 ? "Create the intake" : "None of these: create a new intake"}
          </button>
        </div>
      )}
    </form>
  );
}

function ReferralForm() {
  const router = useRouter();
  const [referredName, setReferredName] = useState("");
  const [referredPhone, setReferredPhone] = useState("");
  const [referredEmail, setReferredEmail] = useState("");
  const [referrerType, setReferrerType] = useState("lawyer");
  const [referrerName, setReferrerName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await postJson<{ intakeSessionId: string }>("/api/intake/referrals", {
      referredName,
      referredPhone: referredPhone || null,
      referredEmail: referredEmail || null,
      referrerType,
      referrerName: referrerName || null,
      notes: notes || null,
    });
    if (err || !data) {
      setBusy(false);
      return setError(err ?? "The referral wasn't recorded.");
    }
    router.push(`/admin/intake/${data.intakeSessionId}`);
  }

  return (
    <form
      className="glass-card space-y-4 rounded-[1.25rem] p-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-slate-600">
        Nothing is sent to the referred person. The referral goes live when they contact the firm, or when you record that they asked to be contacted.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 sm:col-span-2">
          <span className={LABEL}>Referred person&apos;s name</span>
          <input className={INPUT} value={referredName} onChange={(e) => setReferredName(e.target.value)} autoComplete="off" required />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Their phone (optional)</span>
          <input className={INPUT} value={referredPhone} onChange={(e) => setReferredPhone(e.target.value)} inputMode="tel" autoComplete="off" />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Their email (optional)</span>
          <input className={INPUT} value={referredEmail} onChange={(e) => setReferredEmail(e.target.value)} type="email" autoComplete="off" />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Referred by</span>
          <select className={INPUT} value={referrerType} onChange={(e) => setReferrerType(e.target.value)}>
            <option value="lawyer">A lawyer</option>
            <option value="client">A client</option>
            <option value="other">Someone else</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Referrer&apos;s name (optional)</span>
          <input className={INPUT} value={referrerName} onChange={(e) => setReferrerName(e.target.value)} autoComplete="off" />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className={LABEL}>Notes for the intake team (no case details)</span>
          <textarea className={INPUT} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      {error ? (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy || !referredName.trim()} className={BUTTON}>
        {busy ? "Saving…" : "Record the referral"}
      </button>
    </form>
  );
}
