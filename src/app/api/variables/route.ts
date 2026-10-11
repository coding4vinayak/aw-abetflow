import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { readJson, validateBody } from "@/lib/validate";
import { VARIABLE_PUT } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const variables = await prisma.variable.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ variables });
}

async function POST_impl(request: Request) {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.error;
  const { body } = parsed;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, VARIABLE_PUT);
  if (!input.ok) return input.error;
  const { name, value } = input.data;

  // The shape of the word is a second rule on top of the type: `{{vars.name}}`
  // only resolves an identifier, so a name the template language cannot read is
  // refused even though the column would hold it. Kept out of the table because
  // it is a pattern, not a type.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return NextResponse.json({ error: "name must be a valid identifier" }, { status: 422 });
  }

  const variable = await prisma.variable.upsert({
    where: { workspaceId_name: { workspaceId, name } },
    update: { value },
    create: { workspaceId, name, value },
  });
  return NextResponse.json(variable, { status: 201 });
}

async function DELETE_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const name = searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  // `delete` on a composite key that names no row throws P2025, which `withAuth`
  // rethrows as a 500 — a name that is simply absent should be a 404, the same answer
  // `workflows/[id]` and `executions/[id]` give for a row that is not there. `deleteMany`
  // is the race-free form: it deletes the one scoped row and reports `count` instead of
  // throwing (its `where` is the general `WhereInput`, so the tenant and name are two
  // fields, not the compound-unique selector `delete` takes). `workspaceId` in the filter
  // already scopes it to the caller's tenant, so count 0 means "not in your workspace" and
  // discloses nothing about another tenant's.
  const deleted = await prisma.variable.deleteMany({ where: { workspaceId, name } });
  if (deleted.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
