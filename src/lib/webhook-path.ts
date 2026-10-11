import { prisma } from "./db";

/**
 * #75. `webhooks/[...path]` resolves an inbound slug by scanning every ACTIVE
 * workflow's `trigger.path` — a global namespace with no column to enforce
 * uniqueness against. Two tenants picking "orders" means one silently loses.
 *
 * The read cannot cheaply gain a `where` that names the path (SQLite Json
 * filtering is not first-class in the Prisma DSL), so this is the write-side
 * half: refuse to activate a workflow whose webhook path already belongs to
 * another ACTIVE row. A caller wanting "orders" and finding it taken gets 409
 * with the owning workspace id, not a workflow that quietly shares the slug.
 */
export interface ActiveWebhookPathClaim {
  id: string;
  workspaceId: string;
}

export async function findActiveWebhookPathConflict(
  path: string,
  selfId?: string,
): Promise<ActiveWebhookPathClaim | null> {
  const candidates = await prisma.workflow.findMany({
    where: { status: "ACTIVE", ...(selfId ? { id: { not: selfId } } : {}) },
    select: { id: true, workspaceId: true, trigger: true },
  });
  for (const c of candidates) {
    const t = c.trigger as unknown as { kind?: string; path?: string } | null;
    if (t?.kind === "webhook" && t.path === path) {
      return { id: c.id, workspaceId: c.workspaceId };
    }
  }
  return null;
}

/**
 * `parseTrigger` returns `{ kind: "manual" } | { kind: "webhook", path, … } |
 * { kind: "cron", cron, … }`. Only the webhook shape can collide, so callers
 * read the path here rather than re-checking `kind` at every write site.
 */
export function webhookPathOf(trigger: unknown): string | null {
  const t = trigger as { kind?: string; path?: string } | null;
  return t?.kind === "webhook" && typeof t.path === "string" ? t.path : null;
}
