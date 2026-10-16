import { prisma } from "./db";
import { assertAllowedTarget } from "./egress";
import crypto from "crypto";

/**
 * The events this product emits, and the only events a subscription may name.
 *
 * An automation platform is mostly useful for the two moments a run ends: the
 * fact worth telling a CRM is "that flow finished" — or "it failed" — not the
 * individual steps inside it, which the trace already records. `unknownEventsProblem`
 * refuses a name nothing emits at subscription time, `tests/unit/webhook-dispatch.test.ts`
 * refuses a declared event with no emitter, and the README documents these two as the
 * contract. Adding an event is two lines — the name here, the emission in `runner.ts` —
 * and the guard fails until both exist.
 */
export const WEBHOOK_EVENTS = ["execution.completed", "execution.failed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Whether a subscription's stored comma string names this event. */
export function matchesEvent(stored: string, event: string): boolean {
  return stored
    .split(",")
    .map((s) => s.trim())
    .includes(event);
}

/** The reason to show the caller, or null when every name is one this product emits. */
export function unknownEventsProblem(requested: string[]): string | null {
  const invalid = requested.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (invalid.length === 0) return null;
  return `Unknown events: ${invalid.join(", ")}. Valid events: ${WEBHOOK_EVENTS.join(", ")}`;
}

/**
 * Deliver one event to every active subscription that names it.
 *
 * Inline and best-effort: the run that emitted the event has already committed
 * its terminal row, and a receiver that is down must not turn that into a
 * failure of the run. Never throws — the subscription load is guarded and the
 * deliveries go through `Promise.allSettled`, so one dead endpoint cannot
 * silence the others.
 */
export async function triggerWebhooks(workspaceId: string, event: WebhookEvent, data: unknown): Promise<void> {
  let hooks;
  try {
    hooks = await prisma.webhook.findMany({ where: { workspaceId, isActive: true } });
  } catch (error) {
    console.error(`[webhooks] could not load subscriptions for ${event}`, error);
    return;
  }
  const matching = hooks.filter((hook) => matchesEvent(hook.events, event));
  if (matching.length === 0) return;

  // One id, one timestamp for every receiver of this logical event: a receiver
  // that deduplicates on `id` treats two deliveries to two endpoints as the one
  // event it was, and a retry — if delivery ever grows retries — as a duplicate.
  const payload = {
    id: `evt_${crypto.randomBytes(12).toString("base64url")}`,
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  await Promise.allSettled(matching.map((hook) => deliver(hook.id, hook.url, hook.secret, payload)));
}

async function deliver(
  hookId: string,
  rawUrl: string,
  secret: string,
  payload: { id: string; event: string; timestamp: string; data: unknown },
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  try {
    await assertAllowedTarget(rawUrl, "url");
    const response = await fetch(rawUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Abetflow-Signature": signature,
        // The same digest, spelled the way receivers outside this family
        // expect: `sha256=` + hex over the raw body is GitHub's convention and
        // what an inbound nuCRM plugin webhook verifies. The family header
        // stays byte-identical — a receiver that already verifies it keeps
        // working, and one that only knows the generic name now does too.
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-Abetflow-Event": payload.event,
        "User-Agent": "Abetflow-Webhook/1.0",
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`[webhooks] ${hookId} answered ${response.status}`);
    }
  } catch (error) {
    console.error(`[webhooks] delivery to ${hookId} failed`, error);
  }
}

/**
 * The row as read routes may show it: everything but the signing secret. The
 * secret is returned by POST — the one moment it exists — so nothing needs a
 * GET to hand it back, and a workspace's readers do not walk away with keys
 * that sign as this product.
 */
export function webhookPreview<T extends { secret: string }>(
  webhook: T,
): Omit<T, "secret"> & { secretPreview: string } {
  const { secret, ...rest } = webhook;
  return { ...rest, secretPreview: `${secret.slice(0, 12)}…` };
}
