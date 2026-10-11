import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { runExecution } from "@/lib/runner";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const execution = await prisma.execution.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { position: "asc" } },
      workflow: { select: { id: true, name: true } },
    },
  });
  if (!execution) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, execution.workspaceId);
  return NextResponse.json(execution);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  if (action !== "retry") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const failed = await prisma.execution.findUnique({
    where: { id },
    include: { workflow: true },
  });
  if (!failed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, failed.workspaceId);
  if (failed.status !== "FAILED") {
    return NextResponse.json({ error: "Only failed executions retry" }, { status: 409 });
  }

  const retry = await prisma.execution.create({
    data: {
      workspaceId: failed.workspaceId,
      workflowId: failed.workflowId,
      source: "retry",
      status: "QUEUED",
      ...(failed.input != null ? { input: asInputJson(failed.input) } : {}),
    },
  });

  try {
      await enqueue(queues.runs, "run-execution", { executionId: retry.id });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  return NextResponse.json(retry, { status: 202 });
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.execution.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.execution.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
