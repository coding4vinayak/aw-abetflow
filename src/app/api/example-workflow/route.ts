import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { authedWorkspaceId } from "@/lib/apikeys";
import { loadExampleWorkflow, removeExampleWorkflow } from "@/lib/example-workflow";

export const dynamic = "force-dynamic";

/**
 * The example workflow: one flow that has already run, and the way to take it
 * away again.
 *
 * `POST` loads it, `DELETE` removes it. Both are one click on the dashboard,
 * which is the point: a signup that starts on an empty dashboard ends on a
 * cancelled subscription, and the empty dashboard's own advice ("create one
 * via `POST /api/workflows`") is advice for a buyer who already writes code.
 *
 * The door is a **session or a key**, not a key only. The dashboard is the
 * browser; the API is the machine. A prospect who signs up on the web and a
 * prospect who integrates the API are the same prospect, and neither of them
 * should have to wait for the other to see the product work.
 *
 * The example is example data by name, and `DELETE` removes exactly that —
 * see `lib/example-workflow.ts` for the rules.
 */
async function POST_impl(request: Request) {
  const session = await getSession();
  let workspaceId = session?.workspaceId;
  if (!workspaceId) {
    try {
      workspaceId = await authedWorkspaceId(request);
    } catch {
      return NextResponse.json({ error: "Sign in, or send an API key." }, { status: 401 });
    }
  }

  const result = await loadExampleWorkflow(workspaceId);
  return NextResponse.json({ ok: true, ...result }, { status: result.created ? 201 : 200 });
}

/** Take the example away: the workspace is empty again, and only it. */
async function DELETE_impl(request: Request) {
  const session = await getSession();
  let workspaceId = session?.workspaceId;
  if (!workspaceId) {
    try {
      workspaceId = await authedWorkspaceId(request);
    } catch {
      return NextResponse.json({ error: "Sign in, or send an API key." }, { status: 401 });
    }
  }

  const removed = await removeExampleWorkflow(workspaceId);
  return NextResponse.json({ ok: true, ...removed });
}

export const POST = POST_impl;
export const DELETE = DELETE_impl;
