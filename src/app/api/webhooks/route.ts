import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { readJson, validateBody, eventNames, NO_FIELD_TO_UPDATE } from "@/lib/validate";
import { unknownEventsProblem, webhookPreview } from "@/lib/webhooks";
import { classifyTarget } from "@/lib/egress";
import { WEBHOOK_CREATE, WEBHOOK_PATCH } from "@/lib/fields";
import crypto from "crypto";

export const dynamic = "force-dynamic";

/**
 * Outbound webhook subscriptions.
 *
 * The item endpoints carry the id as `?id=` rather than a path segment on
 * purpose: `/api/webhooks/{path}` is the inbound trigger route — `{path}` is
 * any slug a workflow registers — and a `[id]` segment here would match the
 * single-segment slugs first. Measured before this shape was chosen:
 * `GET /api/webhooks/orders` answered this file's 404 and `POST` 405'd,
 * and the trigger route was never reached. The collection path is free (the
 * trigger route needs at least one segment); updates and deletes name their
 * row the way `variables` and `credentials` already name theirs.
 */

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const webhooks = await prisma.webhook.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
  // The signing secret is returned by POST, once; readers get the prefix.
  return NextResponse.json({ webhooks: webhooks.map(webhookPreview) });
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, WEBHOOK_CREATE);
  if (!input.ok) return input.error;

  // The README shows an array of event names; the column is a String and the
  // reader splits it on commas. Both shapes are accepted, one is stored.
  const events = eventNames(body.events);
  if (!events.ok) return events.error;

  // A name this product never emits is a subscription that never fires — the
  // same silence as no subscription at all, arrived at from the other side.
  // The typo is refused here instead of stored.
  const unknown = unknownEventsProblem(events.values);
  if (unknown) return NextResponse.json({ error: unknown }, { status: 400 });

  // The destination is refused here when it names an internal address — the
  // same rule `assertAllowedTarget` enforces immediately above the delivery
  // fetch — so a subscription that could never deliver is not stored. The
  // documented local override (`ABET_ALLOW_PRIVATE_TARGETS=1`) still applies.
  const target = await classifyTarget(input.data.url, "url");
  if (!target.ok) return NextResponse.json({ error: target.reason }, { status: 400 });

  const secret = crypto.randomBytes(32).toString("hex");
  const webhook = await prisma.webhook.create({
    data: { workspaceId, url: input.data.url, events: events.values.join(","), secret },
  });
  return NextResponse.json(webhook, { status: 201 });
}

async function PATCH_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body;

  // The row holds the signing secret, and the id comes from the caller, so
  // ownership is asserted after the load and answers 404 for someone else's id —
  // a probe cannot tell "does not exist" from "not yours".
  const owned = await prisma.webhook.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!owned || owned.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const input = validateBody(body, WEBHOOK_PATCH);
  if (!input.ok) return input.error;

  // `events` is checked outside the table because the two shapes are not the
  // same: an array or a comma string both arrive, one comma string is stored.
  const events = body.events === undefined ? undefined : eventNames(body.events);
  if (events && !events.ok) return events.error;
  // Same rule as POST: a name this product never emits is refused, not stored.
  if (events?.ok) {
    const unknown = unknownEventsProblem(events.values);
    if (unknown) return NextResponse.json({ error: unknown }, { status: 400 });
  }

  // Same refusal as POST when the patch repoints the subscription.
  if (input.data.url !== undefined) {
    const target = await classifyTarget(input.data.url, "url");
    if (!target.ok) return NextResponse.json({ error: target.reason }, { status: 400 });
  }

  const data = { ...input.data, ...(events?.values ? { events: events.values.join(",") } : {}) };
  // A body holding only `events` is a write the field table cannot see, so the
  // emptiness check runs on the merged object, not on `input.data`.
  if (!Object.keys(data).length) return NextResponse.json({ error: NO_FIELD_TO_UPDATE }, { status: 400 });

  const webhook = await prisma.webhook.update({ where: { id }, data });
  return NextResponse.json(webhookPreview(webhook));
}

async function DELETE_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const deleted = await prisma.webhook.deleteMany({ where: { id, workspaceId } });
  if (deleted.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
