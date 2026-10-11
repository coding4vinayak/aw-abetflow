import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { runExecution } from "@/lib/runner";

export const dynamic = "force-dynamic";

async function trigger(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const slug = path.join("/").replace(/^\/+|\/+$/g, "");
  if (!slug) return NextResponse.json({ error: "Missing webhook path" }, { status: 404 });

  const matches = (
    await prisma.workflow.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, workspaceId: true, trigger: true },
    })
  ).filter((w) => {
    const t = w.trigger as unknown as { kind?: string; path?: string; secret?: string } | null;
    return t?.kind === "webhook" && t.path === slug;
  });
  if (matches.length === 0) return NextResponse.json({ error: "No active workflow on this path" }, { status: 404 });
  // #75. `find + first match` was the silent pick: two ACTIVE rows sharing a
  // path meant whichever Prisma returned first owned every inbound call, and
  // the other tenant's flow never ran. The create/PATCH routes now refuse to
  // activate into a collision, so reaching here means the write-side guard was
  // bypassed (or the schema predates it) — say so loudly rather than route to
  // the wrong workflow.
  if (matches.length > 1) {
    return NextResponse.json(
      { error: "Webhook path is claimed by more than one active workflow. Pause or re-path all but one." },
      { status: 503 },
    );
  }
  const match = matches[0];

  // Authenticating the trigger, not the caller: whoever knows the path may run
  // this tenant's workflow, so the path alone cannot be the credential. A
  // trigger with no secret used to fall straight through — and `!==` on a secret
  // is a comparison whose running time depends on how much of it matched.
  const trigger = match.trigger as unknown as { secret?: string; public?: boolean };
  if (!trigger.public) {
    if (!trigger.secret) {
      return NextResponse.json(
        { error: "This webhook has no signing secret. Edit the workflow trigger to set one, or set public: true to accept unauthenticated calls." },
        { status: 401 },
      );
    }
    const url = new URL(request.url);
    const key = request.headers.get("x-api-key") ?? url.searchParams.get("key");
    const expected = Buffer.from(trigger.secret, "utf8");
    const given = Buffer.from(typeof key === "string" ? key : "", "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return NextResponse.json({ error: "Invalid webhook secret" }, { status: 401 });
    }
  }

  // sync=true runs the workflow inside this request and hands the caller the
  // finished Execution. That is fine for a caller who presented the secret —
  // the credential attributes the work — but not for one on a `public: true`
  // trigger, where an anonymous hit could hold the request open for the whole
  // duration of a tenant's flow. Refused before `execution.create` so the
  // refused call leaves no QUEUED row behind. Filed as #74.
  const { searchParams } = new URL(request.url);
  const wantsSync = searchParams.get("sync") === "true";
  if (wantsSync && trigger.public) {
    return NextResponse.json(
      { error: "sync=true is not available on a public trigger; omit sync to enqueue, or add the webhook's secret to authenticate." },
      { status: 400 },
    );
  }

  let input: unknown = null;
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    try {
      input = contentType.includes("application/json") ? await request.json() : await request.text();
    } catch {
      input = null;
    }
  }

  const execution = await prisma.execution.create({
    data: {
      workspaceId: match.workspaceId,
      workflowId: match.id,
      source: "webhook",
      status: "QUEUED",
      ...(input !== undefined && input !== null ? { input: input as object } : {}),
    },
  });

  if (wantsSync) {
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
  return NextResponse.json({ executionId: execution.id, status: "QUEUED" }, { status: 202 });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return trigger(request, ctx);
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return trigger(request, ctx);
}
