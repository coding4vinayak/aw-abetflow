import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { sealCredential } from "@/lib/crypto";
import { readJson, validateBody } from "@/lib/validate";
import { CREDENTIAL_PUT } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const rows = await prisma.credential.findMany({
    where: { workspaceId },
    // Ciphertext never leaves the server. Listing names is safe; values are not.
    select: { id: true, name: true, provider: true, createdAt: true, updatedAt: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ credentials: rows });
}

async function POST_impl(request: Request) {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.error;
  const { body } = parsed;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, CREDENTIAL_PUT);
  if (!input.ok) return input.error;
  const { name, provider, value } = input.data;

  // A pattern rather than a type: this name is looked up by connector code, so it
  // stays in [a-z0-9_-]. It ran on `String(name)` before, which is how `42` and
  // `["n5_carr"]` passed the check and then failed inside Prisma.
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    return NextResponse.json({ error: "name uses [a-z0-9_-]" }, { status: 422 });
  }

  let sealed: { ciphertext: string; iv: string };
  try {
    sealed = sealCredential(value);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Encryption unavailable" },
      { status: 500 },
    );
  }

  const row = await prisma.credential.upsert({
    where: { workspaceId_name: { workspaceId, name } },
    update: { provider, ciphertext: sealed.ciphertext, iv: sealed.iv },
    create: { workspaceId, name, provider, ciphertext: sealed.ciphertext, iv: sealed.iv },
  });
  return NextResponse.json({ id: row.id, name: row.name, provider: row.provider }, { status: 201 });
}

async function DELETE_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const name = searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  // The same missing-row path as `variables`: `delete` throws P2025 on a name that is not
  // there and `withAuth` turns it into a 500. `deleteMany` reports `count` instead, filtered
  // on the caller's `workspaceId` and the `name` (the general `WhereInput`, not the
  // compound-unique selector), so a miss is the app's 404.
  const deleted = await prisma.credential.deleteMany({ where: { workspaceId, name } });
  if (deleted.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
