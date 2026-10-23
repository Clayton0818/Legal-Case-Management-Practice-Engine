import { IntakeChatWidget } from "@/components/intake/IntakeChatWidget";

// Board card c23. Per ADR-0001 §D3 this stays a plain Next.js page for
// now — see IntakeChatWidget's own comment for why the actual chat logic
// lives in a framework-agnostic component instead of here, which is the
// boundary that keeps a future standalone-embeddable rewrite cheap.
//
// Espresso & champagne theme: on phones the chat fills the screen; on
// tablet and desktop it sits in a rounded espresso panel.
export default function ChatHome() {
  return (
    <div className="mx-auto flex h-[100dvh] max-w-xl flex-col md:py-8">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-espresso-panel md:rounded-4xl md:border md:border-white/10">
        <header className="flex items-center justify-between gap-3 border-b border-white/5 px-5 py-4 md:px-7 md:py-5">
          <div>
            <h1 className="font-display text-2xl leading-tight text-ivory-bright md:text-3xl">Talk to our intake team</h1>
            <p className="mt-0.5 text-xs text-taupe-dim md:text-sm">Confidential · a person reviews every inquiry</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-2 text-xs font-medium text-taupe">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#7FC29B]" />
            Secure
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <IntakeChatWidget />
        </div>
      </div>
    </div>
  );
}
