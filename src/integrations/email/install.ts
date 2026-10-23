// Chooses the email adapter for this process from environment variables and
// installs it into the notification outbox (src/core/notify.ts).
//
//   EMAIL_PROVIDER=postmark       turn on the Postmark adapter
//   POSTMARK_SERVER_TOKEN=…       Postmark "Server API token" (secret)
//   EMAIL_FROM_ADDRESS=…          default sender on a verified domain
//   POSTMARK_MESSAGE_STREAM=…     optional, default "outbound"
//
// Anything else (unset, or a missing token) keeps the StubProvider, which
// records and holds. Either way the 'vendor.email' gate still decides whether
// a row may be sent at all. Called once at the start of every worker tick
// (src/worker/tick.ts), which is the only place the outbox is drained.

import { setNotificationProviders } from "@/core/notify";
import { PostmarkEmailProvider } from "./postmark";

type Env = Record<string, string | undefined>;

export interface EmailInstallResult {
  provider: "postmark" | "stub";
  /** Why the stub was kept, when it was. Never contains secrets. */
  reason: string | null;
}

/** Pure: which adapter the environment asks for (null = keep the stub). */
export function emailProviderFromEnv(env: Env = process.env): { provider: PostmarkEmailProvider | null; reason: string | null } {
  const choice = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (!choice || choice === "stub") return { provider: null, reason: "EMAIL_PROVIDER is not set." };
  if (choice !== "postmark") return { provider: null, reason: `Unknown EMAIL_PROVIDER '${choice}'.` };
  const token = (env.POSTMARK_SERVER_TOKEN ?? "").trim();
  if (!token) return { provider: null, reason: "EMAIL_PROVIDER=postmark but POSTMARK_SERVER_TOKEN is not set." };
  const from = (env.EMAIL_FROM_ADDRESS ?? "").trim();
  return {
    provider: new PostmarkEmailProvider({
      serverToken: token,
      defaultFromAddress: from || null,
      messageStream: (env.POSTMARK_MESSAGE_STREAM ?? "").trim() || "outbound",
    }),
    reason: from ? null : "EMAIL_FROM_ADDRESS is not set; only firms with their own verified sender address can send.",
  };
}

/** Install the adapter the environment asks for. Returns what happened, for the tick log. */
export function installEmailProviderFromEnv(env: Env = process.env): EmailInstallResult {
  const { provider, reason } = emailProviderFromEnv(env);
  if (!provider) return { provider: "stub", reason };
  setNotificationProviders({ email: provider });
  return { provider: "postmark", reason };
}
