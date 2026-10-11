import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { nextRunAtFor } from "@/lib/cron";
import { parseDefinition, parseTrigger } from "@/lib/definition";
import { findActiveWebhookPathConflict, webhookPathOf } from "@/lib/webhook-path";
import { NO_FIELD_TO_UPDATE, readJson, validateBody } from "@/lib/validate";
import { WORKFLOW_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

const MAX_VERSIONS = 50;

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = await prisma.workflow.findUnique({
    where: { id },
    include: {
      versions: { orderBy: { version: "desc" }, take: 10 },
      executions: { orderBy: { createdAt: "desc" }, take: 20, include: { _count: { select: { steps: true } } } },
    },
  });
  if (!workflow) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, workflow.workspaceId);
  return NextResponse.json(workflow);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.error;

  const current = await prisma.workflow.findUnique({
    where: { id },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, current.workspaceId);

  const input = validateBody(parsed.body, WORKFLOW_PATCH);
  if (!input.ok) return input.error;
  const { name, description, trigger, definition, status, note } = input.data;

  // `note` belongs to the snapshot rather than the workflow, so the engine's own
  // "nothing to update" check cannot see what this route counts as a write.
  // Without it, a PATCH that sent nothing was a 200 that created a WorkflowVersion
  // row anyway — measured on a copy of the database, 1 version became 3 across an
  // empty PATCH and a `note: 42` whose value was dropped on the floor.
  const changesWorkflow =
    name !== undefined || description !== undefined || trigger !== undefined || definition !== undefined || status !== undefined;
  if (!changesWorkflow) {
    return NextResponse.json({ error: NO_FIELD_TO_UPDATE }, { status: 400 });
  }

  let nextTrigger: unknown = current.trigger;
  if (trigger !== undefined) {
    const t = parseTrigger(trigger);
    if (!t.ok) return NextResponse.json({ error: t.error }, { status: 422 });
    nextTrigger = t.trigger;
  }
  let nextDefinition: unknown = current.definition;
  if (definition !== undefined) {
    const d = parseDefinition(definition);
    if (!d.ok) return NextResponse.json({ error: d.error }, { status: 422 });
    nextDefinition = { nodes: d.nodes };
  }

  const nextVersion = (current.versions[0]?.version ?? 0) + 1;
  // `nextRunAt` follows the row's *resulting* trigger and status, not whichever field the
  // caller happened to send: `{status:"ACTIVE"}` alone is the PATCH that turns a stored cron
  // into a schedule, and a trigger edit on a DRAFT is not. Reading only `trigger` used to
  // mean exactly that first case left the column untouched.
  const effectiveTrigger = trigger !== undefined ? nextTrigger : current.trigger;
  const effectiveStatus = status ?? current.status;

  // #75. Same rule as the create route: the path can only collide when the row
  // lands ACTIVE, so a DRAFT or PAUSED edit that re-homes a trigger never
  // consults the check. But a status transition to ACTIVE absolutely does —
  // measured here before the fix, two ACTIVE workflows could carry the same
  // webhook path and the inbound route silently picked whichever Prisma
  // returned first. The `selfId` argument is what stops a no-op PATCH on a
  // workflow that already owns the path from refusing itself.
  if (effectiveStatus === "ACTIVE") {
    const slug = webhookPathOf(effectiveTrigger);
    if (slug) {
      const clash = await findActiveWebhookPathConflict(slug, id);
      if (clash) {
        return NextResponse.json(
          { error: `Another active workflow already owns webhook path "${slug}" (workspace ${clash.workspaceId}).` },
          { status: 409 },
        );
      }
    }
  }

  const [, workflow] = await prisma.$transaction([
    prisma.workflowVersion.create({
      data: {
        workflowId: id,
        version: nextVersion,
        trigger: asInputJson(nextTrigger),
        definition: asInputJson(nextDefinition),
        ...(typeof note === "string" ? { note } : {}),
      },
    }),
    prisma.workflow.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(trigger !== undefined ? { trigger: asInputJson(nextTrigger) } : {}),
        ...(definition !== undefined ? { definition: asInputJson(nextDefinition) } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(trigger !== undefined || status !== undefined
          ? { nextRunAt: nextRunAtFor(effectiveTrigger, effectiveStatus) }
          : {}),
      },
    }),
  ]);

  const pruned = await prisma.workflowVersion.deleteMany({
    where: { workflowId: id, version: { lt: nextVersion - MAX_VERSIONS + 1 } },
  });

  return NextResponse.json({ ...workflow, prunedVersions: pruned.count });
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.workflow.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.workflow.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
