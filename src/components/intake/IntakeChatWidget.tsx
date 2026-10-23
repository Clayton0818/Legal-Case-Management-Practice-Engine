"use client";

import { useEffect, useRef, useState } from "react";
import type { Prompt } from "@/lib/intakeEntryFlow/types";

type ChatMessage = { id: string; from: "bot" | "caller"; text: string };

interface SessionResponse {
  id: string;
  currentNode: string;
  collectedAnswers?: Record<string, unknown>;
  terminalState?: string | null;
  sessionEnded?: boolean;
  prompt: Prompt;
  error?: string;
  fieldErrors?: Record<string, string>;
}

const STORAGE_KEY = "legal-intake:chat-session-id";
const GENERIC_ERROR = "Something went wrong. Please try again, or contact the firm directly.";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `m${idCounter}`;
}

// Espresso & champagne theme classes, kept together so the widget's look is
// easy to lift with it when it becomes a standalone embeddable bundle.
const CHIP =
  "min-h-[44px] rounded-full border border-champagne/50 bg-champagne/10 px-5 text-sm font-medium text-ivory-bright transition hover:bg-champagne/20";
const FIELD =
  "w-full min-h-[48px] rounded-2xl border border-white/10 bg-espresso-deep px-4 py-3 text-base text-ivory-bright placeholder:text-taupe-faint";
const PRIMARY =
  "inline-flex min-h-[48px] items-center justify-center gap-2 rounded-full bg-champagne px-6 text-sm font-semibold text-espresso-deep transition hover:bg-champagne-light";

// Framework-agnostic on purpose (ADR-0001 §D3): this component only uses
// fetch + React state, no next/navigation or other Next-only APIs, so a
// future standalone-embeddable rewrite of this widget (before any real
// firm embeds it on their own site) can lift it with minimal changes. The
// only Next-specific thing about this feature is the thin page at
// src/app/chat/page.tsx that renders it.
export function IntakeChatWidget({ apiBase = "/api/intake" }: { apiBase?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const startedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
    // Intentionally run-once: this widget owns exactly one session, and
    // `start` is a stable function defined in this component's body with
    // no reactive dependencies of its own.
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function addBotMessage(text: string) {
    setMessages((prev) => [...prev, { id: nextId(), from: "bot", text }]);
  }

  function addCallerMessage(text: string) {
    setMessages((prev) => [...prev, { id: nextId(), from: "caller", text }]);
  }

  function readStoredSessionId(): string | null {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private browsing / blocked storage — fall back to a fresh session
      // every time. Non-critical: it only costs the caller re-answering.
      return null;
    }
  }

  function storeSessionId(id: string) {
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Non-critical, see readStoredSessionId().
    }
  }

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const existingId = readStoredSessionId();

      if (existingId) {
        const res = await fetch(`${apiBase}/sessions/${existingId}`);
        if (res.ok) {
          const data = (await res.json()) as SessionResponse;
          setSessionId(data.id);
          setPrompt(data.prompt);
          setEnded(Boolean(data.prompt.final));
          addBotMessage(data.prompt.message);
          setLoading(false);
          return;
        }
        // Stale/expired/not-found id — fall through and start fresh.
      }

      const res = await fetch(`${apiBase}/sessions`, { method: "POST" });
      const data = (await res.json()) as SessionResponse;
      if (!res.ok) {
        setError(
          data.error ??
            "We couldn't start your intake right now. Please refresh the page or contact the firm directly."
        );
        setLoading(false);
        return;
      }
      setSessionId(data.id);
      setPrompt(data.prompt);
      addBotMessage(data.prompt.message);
      storeSessionId(data.id);
    } catch {
      setError(
        "We couldn't start your intake right now. Please refresh the page or contact the firm directly."
      );
    } finally {
      setLoading(false);
    }
  }

  async function submit(input: Record<string, unknown>, callerSummary: string) {
    if (!sessionId) return;
    setError(null);
    addCallerMessage(callerSummary);
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const data = (await res.json()) as SessionResponse;
      if (!res.ok) {
        setError(data.error ?? GENERIC_ERROR);
        setLoading(false);
        return;
      }
      setPrompt(data.prompt);
      addBotMessage(data.prompt.message);
      if (data.prompt.final) setEnded(true);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-xl flex-col">
      <div ref={scrollRef} aria-live="polite" className="flex-1 space-y-3 overflow-y-auto px-4 py-5 md:px-7">
        {messages.map((m) => (
          <div key={m.id} className={m.from === "bot" ? "flex justify-start" : "flex justify-end"}>
            <div
              className={
                m.from === "bot"
                  ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-espresso-bubble px-4 py-3 text-[15px] leading-relaxed text-ivory-text"
                  : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-champagne px-4 py-3 text-[15px] leading-relaxed text-espresso-deep"
              }
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div role="alert" className="mx-4 mb-2 rounded-2xl border border-[#B5503F]/40 bg-[#B5503F]/15 px-4 py-3 text-sm text-[#F3D3CC] md:mx-7">
          {error}
        </div>
      )}

      <div className="border-t border-white/5 px-4 pb-5 pt-4 md:px-7">
        {!ended && prompt && !loading && <PromptInput prompt={prompt} onSubmit={submit} />}
        {loading && (
          <p className="text-sm text-taupe-dim" aria-live="polite">
            …
          </p>
        )}
        {ended && !error && <p className="text-sm text-taupe">This conversation is complete.</p>}
      </div>
    </div>
  );
}

function PromptInput({
  prompt,
  onSubmit,
}: {
  prompt: Prompt;
  onSubmit: (input: Record<string, unknown>, callerSummary: string) => void;
}) {
  const [text, setText] = useState("");
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    setText("");
    setForm({});
  }, [prompt]);

  if (prompt.kind === "single_choice" || prompt.kind === "confirm") {
    return (
      <div className="flex flex-wrap gap-2">
        {(prompt.options ?? []).map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={CHIP}
            onClick={() => {
              if (prompt.kind === "confirm") {
                onSubmit({ confirmed: opt.value === "yes" }, opt.label);
              } else if (prompt.node === "classify_practice_area") {
                onSubmit({ manualPracticeArea: opt.value }, opt.label);
              } else if (prompt.node === "language_routing") {
                onSubmit({ language: opt.value }, opt.label);
              } else {
                onSubmit({ callerType: opt.value }, opt.label);
              }
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    );
  }

  if (prompt.kind === "form") {
    return (
      <form
        className="space-y-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          const summary = [form.fullName, form.email, form.phone].filter(Boolean).join(" · ");
          onSubmit(form, summary || "Submitted.");
        }}
      >
        {(prompt.fields ?? []).map((f) => (
          <input
            key={f.name}
            type={f.type}
            aria-label={f.label}
            placeholder={f.label}
            value={form[f.name] ?? ""}
            onChange={(e) => setForm((prev) => ({ ...prev, [f.name]: e.target.value }))}
            className={FIELD}
          />
        ))}
        <button type="submit" className={PRIMARY}>
          Continue
        </button>
      </form>
    );
  }

  // free_text
  return (
    <form
      className="flex items-end gap-2 rounded-3xl border border-white/10 bg-espresso-deep p-1.5 pl-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSubmit({ practiceAreaFreeText: text }, text);
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        aria-label="Your answer"
        className="min-h-[48px] flex-1 resize-none bg-transparent py-2.5 text-base text-ivory-bright placeholder:text-taupe-faint"
        placeholder="Type your answer…"
      />
      <button
        type="submit"
        aria-label="Send"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-champagne text-espresso-deep transition hover:bg-champagne-light"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 12h15M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.9" fill="none" />
        </svg>
      </button>
    </form>
  );
}
