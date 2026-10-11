import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { nextRunAtFor } from "@/lib/cron";
import { parseDefinition, parseTrigger } from "@/lib/definition";
import { findActiveWebhookPathConflict, webhookPathOf } from "@/lib/webhook-path";
import { readJson, validateBody } from "@/lib/validate";
import { WORKFLOW_CREATE } from "@/lib/fields";
import { pageParams } from "@/lib/pagination";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const status = searchParams.get("status");
  const { page, limit } = pageParams(searchParams, 20);


  const where: { workspaceId: string; status?: string } = { workspaceId };
  if (status) where.status = status;

  const [workflows, total] = await Promise.all([
    prisma.workflow.findMany({
      where,
      include: { _count: { select: { executions: true, versions: true } } },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.workflow.count({ where }),
  ]);

  return NextResponse.json({ workflows, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.error;
  const { body } = parsed;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, WORKFLOW_CREATE);
  if (!input.ok) return input.error;

  // The graph and the trigger keep their own validators: what a webhook needs
  // (a path, and a secret or `public: true`) and what a flow needs (a non-empty
  // set of nodes with resolvable edges) is not a scalar's business.
  const t = parseTrigger(input.data.trigger ?? { kind: "manual" });
  if (!t.ok) return NextResponse.json({ error: t.error }, { status: 422 });
  const d = parseDefinition(input.data.definition);
  if (!d.ok) return NextResponse.json({ error: d.error }, { status: 422 });

  // #75. A DRAFT can hold a path that another ACTIVE workflow already owns —
  // the collision only bites on the inbound route, which reads ACTIVE. Refuse
  // at the moment of activation: the caller sees 409 with the other row's
  // workspace id and can pick a different slug before any inbound traffic
  // silently routes to whichever workflow Prisma happened to return first.
  if ((input.data.status ?? "DRAFT") === "ACTIVE") {
    const slug = webhookPathOf(t.trigger);
    if (slug) {
      const clash = await findActiveWebhookPathConflict(slug);
      if (clash) {
        return NextResponse.json(
          { error: `Another active workflow already owns webhook path "${slug}" (workspace ${clash.workspaceId}).` },
          { status: 409 },
        );
      }
    }
  }

  // Version 1 is the rollback history for a newly created workflow: the executor
  // runs the live `definition` column, but PATCH numbers the next snapshot from
  // the highest version it can find, so a workflow whose first snapshot was lost
  // either has nothing to roll back to or re-bases its numbering to v1 again.
  // One nested write, so the row and its history arrive together or not at all.
  // Deliberately not an interactive $transaction: on SQLite that is a write-lock
  // queue and it collapses under concurrent writes (measured 2.5 rps at c=10,
  // 60% P1008 timeout errors), while the nested create holds ~2,200 rps.
  const triggerJson = asInputJson(t.trigger);
  const definitionJson = asInputJson({ nodes: d.nodes });
  const workflow = await prisma.workflow.create({
    data: {
      workspaceId,
      name: input.data.name,
      ...(input.data.description !== undefined ? { description: input.data.description } : {}),
      trigger: triggerJson,
      definition: definitionJson,
      ...(input.data.status !== undefined ? { status: input.data.status } : {}),
      // One computation, shared with every other writer of `trigger`/`status`, because the
      // column is what the sweep reads and a writer that forgets it leaves a workflow that
      // can never fire. A cron created as a DRAFT gets null on purpose — see nextRunAtFor.
      nextRunAt: nextRunAtFor(t.trigger, input.data.status ?? "DRAFT"),
      versions: {
        create: { version: 1, trigger: triggerJson, definition: definitionJson, note: "Initial version" },
      },
    },
  });

  return NextResponse.json(workflow, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
