"use client";

import { useEffect } from "react";

// Keeps the 30-minute idle clock honest on a signed-in page: activity
// refreshes the session (at most every 5 minutes), and after 30 minutes of
// no activity the page leaves itself — the server enforces the same limit,
// this just stops a shared screen from sitting open on the client's data.

const TOUCH_EVERY_MS = 5 * 60_000;

export function IdleGuard({ expiredPath, idleMs }: { expiredPath: string; idleMs: number }) {
  useEffect(() => {
    let lastActivity = Date.now();
    let lastTouch = 0;
    const touch = () => {
      lastTouch = Date.now();
      fetch("/api/portal/touch", { method: "POST", credentials: "same-origin" })
        .then((r) => {
          if (r.status === 401) window.location.replace(expiredPath);
        })
        .catch(() => {});
    };
    const onActivity = () => {
      lastActivity = Date.now();
      if (lastActivity - lastTouch > TOUCH_EVERY_MS) touch();
    };
    touch();
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity >= idleMs) window.location.replace(expiredPath);
    }, 30_000);
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true });
    return () => {
      window.clearInterval(timer);
      for (const ev of events) window.removeEventListener(ev, onActivity);
    };
  }, [expiredPath, idleMs]);
  return null;
}
