import { prisma } from "./db";
import { asInputJson } from "./json";
import { executeGraph, type WorkflowDef } from "./executor";
import { resolveCredentials } from "./credentials";

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

  await prisma.execution.update({
    where: { id: executionId },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  try {
    const def = readDefinition(execution.workflow.definition);
    const vars: Record<string, unknown> = {};
    const dbVars = await prisma.variable.findMany({ where: { workspaceId: execution.workspaceId } });
    for (const v of dbVars) vars[v.name] = v.value;
    const credentials = await resolveCredentials(execution.workspaceId);

    const result = await executeGraph(def, execution.input ?? null, { vars, credentials });

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
          completedAt: new Date(),
        },
      }),
    ]);
  } catch (error) {
    await prisma.execution.update({
      where: { id: executionId },
      data: {
        status: "FAILED",
        error: error instanceof Error ? error.message : "Unknown error",
        completedAt: new Date(),
      },
    });
  }
}
