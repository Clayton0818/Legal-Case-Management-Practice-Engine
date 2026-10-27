"use client";

// DV safety (c11, c112): one tap leaves the portal. Signs out everywhere in
// the background (sendBeacon survives the navigation) and REPLACES the
// current history entry, so Back does not return here. Without JavaScript
// the link still works: the route signs out and redirects.

export function QuickExit({ exitUrl }: { exitUrl: string }) {
  return (
    <a
      href="/api/portal/quick-exit"
      onClick={(e) => {
        e.preventDefault();
        try {
          if (!navigator.sendBeacon("/api/portal/quick-exit")) {
            void fetch("/api/portal/quick-exit", { method: "POST", keepalive: true, credentials: "same-origin" });
          }
        } catch {
          // leaving matters more than signing out cleanly; the session also expires on its own
        }
        window.location.replace(exitUrl);
      }}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-champagne px-5 text-sm font-semibold text-espresso-deep hover:bg-champagne-light"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4h6v16h-6M4 12h11M10 7l-5 5 5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Quick exit
    </a>
  );
}
