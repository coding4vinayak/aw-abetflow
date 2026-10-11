import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { runExecution } from "@/lib/runner";
import { boolFlag, readJson, validateBody } from "@/lib/validate";
import { EXECUTION_CREATE } from "@/lib/fields";
import { pageParams } from "@/lib/pagination";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const workflowId = searchParams.get("workflowId");
  const status = searchParams.get("status");
  const { page, limit } = pageParams(searchParams, 20);


  const where: { workspaceId: string; workflowId?: string; status?: string } = { workspaceId };
  if (workflowId) where.workflowId = workflowId;
  if (status) where.status = status;

  const [executions, total] = await Promise.all([
    prisma.execution.findMany({
      where,
      include: { workflow: { select: { id: true, name: true } }, _count: { select: { steps: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.execution.count({ where }),
  ]);

  return NextResponse.json({ executions, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.error;
  const { body } = parsed;

  const validated = validateBody(body, EXECUTION_CREATE);
  if (!validated.ok) return validated.error;
  const { workflowId, input } = validated.data;

  // Route control, not a column: `sync === true` is the only thing this route has
  // ever honoured, so a truthy non-boolean meant the caller asked for a result and
  // got a queue receipt. Measured: `sync: "yes"` answered 202 with a QUEUED row.
  const syncFlag = boolFlag(body.sync, "sync");
  if (!syncFlag.ok) return syncFlag.error;

  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!workflow) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, workflow.workspaceId);
  if (workflow.status !== "ACTIVE") {
    return NextResponse.json({ error: `Workflow is ${workflow.status}` }, { status: 409 });
  }
  const trigger = workflow.trigger as unknown as { kind?: string } | null;
  if (trigger?.kind !== "manual") {
    return NextResponse.json({ error: "Only manual workflows trigger here — use the webhook URL or cron" }, { status: 409 });
  }

  const execution = await prisma.execution.create({
    data: {
      workspaceId: workflow.workspaceId,
      workflowId,
      source: "manual",
      status: "QUEUED",
      ...(input !== undefined ? { input } : {}),
    },
  });

  if (syncFlag.value === true) {
    await runExecution(execution.id);
    const done = await prisma.execution.findUnique({
      where: { id: execution.id },
      include: { steps: { orderBy: { position: "asc" } } },
    });
    return NextResponse.json(done, { status: 201 });
  }

  try {
    await enqueue(queues.runs, "run-execution", { executionId: execution.id });
  } catch (error) {
    if (error instanceof QueueUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  return NextResponse.json(execution, { status: 202 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
