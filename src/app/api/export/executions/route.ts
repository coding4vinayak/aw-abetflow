import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { exportDownloadHeaders, exportFilename, executionCsvHeader, executionCsvRow } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * Executions per batch. Each row carries its own step trace, so the batch
 * bounds the number of execution objects held at once without splitting a
 * trace across pages.
 */
const EXECUTION_BATCH = 200;

/**
 * GET /api/export/executions — the audit trail, streamed as CSV.
 *
 * The product's claim is that an auditor can replay exactly what each workflow
 * execution did. This is the door for that: one row per execution with the
 * ordered steps in `steps_json`. Executions have no useful upper bound, so
 * loading them into the workspace JSON would turn a data-rights feature into
 * an out-of-memory error. The stream pages by primary key (`id > cursor`) and
 * writes each batch as it arrives.
 *
 * Authentication is checked before the stream is constructed. The stream only
 * reads the workspaceId captured from that session.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!canManageRoles(session.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin can export the workspace." },
      { status: 403 },
    );
  }

  const workspaceId = session.workspaceId;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor: string | undefined;
      try {
        controller.enqueue(encoder.encode(executionCsvHeader()));
        for (;;) {
          const executions = await prisma.execution.findMany({
            where: { workspaceId, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: "asc" },
            take: EXECUTION_BATCH,
            select: {
              id: true,
              workflowId: true,
              status: true,
              source: true,
              input: true,
              output: true,
              error: true,
              createdAt: true,
              startedAt: true,
              completedAt: true,
              workflow: { select: { name: true } },
              steps: {
                orderBy: { position: "asc" },
                select: {
                  position: true,
                  nodeId: true,
                  nodeType: true,
                  status: true,
                  output: true,
                  error: true,
                  durationMs: true,
                  createdAt: true,
                },
              },
            },
          });
          if (executions.length === 0) break;

          let chunk = "";
          for (const ex of executions) {
            chunk += executionCsvRow({
              ...ex,
              workflowName: ex.workflow.name,
            });
          }
          controller.enqueue(encoder.encode(chunk));

          cursor = executions[executions.length - 1].id;
          if (executions.length < EXECUTION_BATCH) break;
        }
        controller.close();
      } catch (err) {
        console.error("[export] execution audit stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: exportDownloadHeaders(
      exportFilename(session.workspaceSlug, "executions"),
      "text/csv; charset=utf-8",
    ),
  });
}