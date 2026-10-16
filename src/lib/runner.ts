import { prisma } from "./db";
import { asInputJson } from "./json";
import { executeGraph, type WorkflowDef } from "./executor";
import { resolveCredentials } from "./credentials";
import { triggerWebhooks } from "./webhooks";

function readDefinition(raw: unknown): WorkflowDef {
  const def = (raw ?? {}) as { nodes?: unknown };
  return { nodes: Array.isArray(def.nodes) ? def.nodes as WorkflowDef["nodes"] : [] };
}

/**
 * Run one execution end to end and persist the trace. The trace is the
 * product: every step records what the node saw and produced, so a failed
 * run is debuggable instead of mysterious.
 */
export async function runExecution(executionId: string): Promise<void> {
  const execution = await prisma.execution.findUnique({
    where: { id: executionId },
    include: { workflow: true },
  });
  if (!execution || execution.status === "COMPLETED" || execution.status === "FAILED") return;

  const startedAt = new Date();
  await prisma.execution.update({
    where: { id: executionId },
    data: { status: "RUNNING", startedAt },
  });

  try {
    const def = readDefinition(execution.workflow.definition);
    const vars: Record<string, unknown> = {};
    const dbVars = await prisma.variable.findMany({ where: { workspaceId: execution.workspaceId } });
    for (const v of dbVars) vars[v.name] = v.value;
    const credentials = await resolveCredentials(execution.workspaceId);

    const result = await executeGraph(def, execution.input ?? null, { vars, credentials });

    // One timestamp for the row and for the event about the row: a receiver
    // comparing `completedAt` against the trace must not see them disagree.
    const completedAt = new Date();
    await prisma.$transaction([
      prisma.executionStep.createMany({
        data: result.steps.map((s, i) => ({
          executionId,
          position: i,
          nodeId: s.nodeId,
          nodeType: s.nodeType,
          status: s.status,
          ...(s.output !== undefined ? { output: asInputJson(s.output) } : {}),
          ...(s.error != null ? { error: s.error } : {}),
          ...(s.durationMs != null ? { durationMs: s.durationMs } : {}),
        })),
      }),
      prisma.execution.update({
        where: { id: executionId },
        data: {
          status: result.status,
          ...(result.output !== undefined ? { output: asInputJson(result.output) } : {}),
          ...(result.error != null ? { error: result.error } : {}),
          completedAt,
        },
      }),
    ]);

    // After the rows that make the event true. Fire-and-forget on purpose: the
    // terminal row is committed, `triggerWebhooks` never throws, and a dead
    // receiver must not fail a finished run — or hold a worker (or a sync
    // caller) open while its endpoint is tried.
    void triggerWebhooks(
      execution.workspaceId,
      result.status === "FAILED" ? "execution.failed" : "execution.completed",
      {
        executionId,
        workflowId: execution.workflowId,
        source: execution.source,
        status: result.status,
        error: result.error ?? null,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const completedAt = new Date();
    await prisma.execution.update({
      where: { id: executionId },
      data: { status: "FAILED", error: message, completedAt },
    });

    // Same rule as the success path: the row that says FAILED is committed
    // before the event that says so, and delivery can never throw into here.
    void triggerWebhooks(execution.workspaceId, "execution.failed", {
      executionId,
      workflowId: execution.workflowId,
      source: execution.source,
      status: "FAILED",
      error: message,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    });
  }
}
