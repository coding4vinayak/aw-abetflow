import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { nextRunAtFor } from "./cron";

/**
 * Fire every ACTIVE cron workflow whose nextRunAt has passed: one execution
 * per workflow per sweep, then advance the schedule. Idempotent per sweep —
 * a slow run never double-fires because nextRunAt moves before enqueueing.
 *
 * Called from the `abetflow-scheduled` Worker's handler (`queue.ts`), which exists because
 * this function had no call site at all until #55: the export was the whole relationship,
 * and an ACTIVE cron workflow could not fire. What the sweep asks for is `nextRunAt <= now`
 * against a column only the writers set — which is why `nextRunAtFor` is the one place that
 * answer is computed, here included.
 */
export async function runDueCronWorkflows(now: Date = new Date()): Promise<number> {
  const due = await prisma.workflow.findMany({
    where: { status: "ACTIVE", nextRunAt: { lte: now } },
  });

  let fired = 0;
  for (const wf of due) {
    const trigger = wf.trigger as unknown as { kind?: string; cron?: string } | null;
    // A due row whose trigger is not a cron is skipped, and skipping does not clear the
    // column — so such a row would be re-read by every future sweep forever. Nothing can
    // write it: `nextRunAtFor` returns null for a non-cron trigger, and that is the only
    // way this column is set outside this loop.
    if (trigger?.kind !== "cron" || !trigger.cron) continue;
    const [, execution] = await prisma.$transaction([
      prisma.workflow.update({
        where: { id: wf.id },
        data: { nextRunAt: nextRunAtFor(trigger, wf.status, now) },
      }),
      prisma.execution.create({
        data: {
          workspaceId: wf.workspaceId,
          workflowId: wf.id,
          source: "cron",
          status: "QUEUED",
          input: { firedAt: now.toISOString() },
        },
      }),
    ]);
    await enqueue(queues.runs, "run-execution", { executionId: execution.id });
    fired++;
  }
  return fired;
}
