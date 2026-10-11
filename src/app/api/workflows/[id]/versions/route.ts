import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { nextRunAtFor } from "@/lib/cron";
import { readJson, validateBody } from "@/lib/validate";
import { WORKFLOW_ROLLBACK } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.workflow.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  const versions = await prisma.workflowVersion.findMany({
    where: { workflowId: id },
    orderBy: { version: "desc" },
    take: 50,
  });
  return NextResponse.json({ versions });
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Ownership first, body second — the same order PATCH /api/workflows/:id uses.
  // Validating first would answer a caller who is not the owner with a field-level
  // description of what this endpoint accepts.
  const _owned = await prisma.workflow.findUnique({ where: { id }, select: { workspaceId: true, status: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.error;

  const input = validateBody(parsed.body, WORKFLOW_ROLLBACK);
  if (!input.ok) return input.error;
  const version = input.data.version;

  const snapshot = await prisma.workflowVersion.findUnique({
    where: { workflowId_version: { workflowId: id, version } },
  });
  if (!snapshot) return NextResponse.json({ error: "Version not found" }, { status: 404 });

  const current = await prisma.workflowVersion.findFirst({
    where: { workflowId: id },
    orderBy: { version: "desc" },
  });
  const nextVersion = (current?.version ?? 0) + 1;

  const [, workflow] = await prisma.$transaction([
    prisma.workflowVersion.create({
      data: {
        workflowId: id,
        version: nextVersion,
        trigger: asInputJson(snapshot.trigger),
        definition: asInputJson(snapshot.definition),
        note: `Rollback to v${version}`,
      },
    }),
    prisma.workflow.update({
      where: { id },
      // A rollback changes the schedule, so it has to recompute the column the schedule is
      // read from. Leaving the previous version's `nextRunAt` behind meant the next sweep
      // fired the rolled-back workflow at a time only the old cron asked for — then
      // advanced from there, so the mistake became the new baseline.
      data: {
        trigger: asInputJson(snapshot.trigger),
        definition: asInputJson(snapshot.definition),
        nextRunAt: nextRunAtFor(snapshot.trigger, _owned.status),
      },
    }),
  ]);

  return NextResponse.json({ workflow, restoredVersion: version, newVersion: nextVersion });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
