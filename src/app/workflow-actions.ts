"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { requireSession } from "@/lib/session";
import { parseDefinition, parseTrigger } from "@/lib/definition";
import { nextRunAtFor } from "@/lib/cron";
import { runExecution } from "@/lib/runner";

export interface WorkflowState {
  error?: string;
  id?: string;
}

/**
 * Account-style server actions for workflows: create, edit, run.
 *
 * These live apart from the API routes because a browser holds a session
 * cookie rather than a bearer key. The same validation runs in both places —
 * the UI cannot save what the API would reject, so a workflow built here is
 * identical to one built over HTTP.
 */

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A bare form action rather than a state action: it always ends in a redirect,
 * so there is no error state to hand back. An empty name is refused by the
 * input's own `required` attribute instead.
 */
export async function createWorkflow(formData: FormData): Promise<never> {
  const session = await requireSession();
  const name = text(formData, "name") || "Untitled workflow";

  // What the console's create button makes, by construction: a manual draft.
  const newTrigger = { kind: "manual" };
  const newStatus = "DRAFT";

  const workflow = await prisma.workflow.create({
    data: {
      workspaceId: session.workspaceId,
      name,
      trigger: asInputJson(newTrigger),
      definition: asInputJson({ nodes: [] }),
      status: newStatus,
      // Every writer of `nextRunAt` goes through this one call — including the sweep that
      // advances the column itself — so the column has one meaning and the guard in
      // `tests/unit/scheduler.test.ts` can demand it from every site with no exceptions.
      nextRunAt: nextRunAtFor(newTrigger, newStatus),
    },
  });
  redirect(`/workflows/${workflow.id}`);
}

export async function updateWorkflowDefinition(
  _previous: WorkflowState,
  formData: FormData,
): Promise<WorkflowState> {
  const session = await requireSession();
  const id = text(formData, "id");
  const name = text(formData, "name");
  const definition = text(formData, "definition");

  if (!id) return { error: "Missing workflow id." };
  if (!name) return { error: "Give the workflow a name." };

  // Scoped in the query: a row in another workspace is not found, so there is
  // no window where foreign data is loaded before a check runs.
  const existing = await prisma.workflow.findFirst({ where: { id, workspaceId: session.workspaceId } });
  if (!existing) return { error: "Workflow not found." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(definition || '{"nodes":[]}');
  } catch {
    return { error: "The definition is not valid JSON." };
  }

  const nodes = Array.isArray((parsed as { nodes?: unknown }).nodes)
    ? (parsed as { nodes: unknown }).nodes
    : parsed;
  const checked = parseDefinition(Array.isArray(nodes) ? { nodes } : nodes);
  if (!checked.ok) return { error: checked.error };

  const t = parseTrigger(existing.trigger ?? { kind: "manual" });
  if (!t.ok) return { error: t.error };

  await prisma.workflow.update({
    where: { id },
    data: { name, definition: asInputJson({ nodes: checked.nodes }) },
  });
  return { id };
}

export interface RunState {
  error?: string;
  executionId?: string;
}

/**
 * Run a workflow now, synchronously, and return the execution id.
 *
 * Sync because this is what an editor's "try it" button needs: the trace that
 * comes back. A delay node still sleeps its seconds, so a workflow that waits
 * five minutes returns in five minutes — the playground's delay cap applies to
 * interactive runs for the same reason.
 */
export async function runWorkflowNow(_previous: RunState, formData: FormData): Promise<RunState> {
  const session = await requireSession();
  const id = text(formData, "id");
  const rawInput = text(formData, "input");

  const workflow = await prisma.workflow.findFirst({ where: { id, workspaceId: session.workspaceId } });
  if (!workflow) return { error: "Workflow not found." };
  if (workflow.status !== "ACTIVE") {
    return { error: `Only an ACTIVE workflow can run — this one is ${workflow.status}.` };
  }
  const trigger = workflow.trigger as unknown as { kind?: string } | null;
  if (trigger?.kind !== "manual") {
    return { error: "Only manual workflows run from here. Webhook and cron workflows run on their own schedule." };
  }

  let input: unknown = null;
  if (rawInput) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      return { error: "The sample input is not valid JSON." };
    }
  }

  const execution = await prisma.execution.create({
    data: {
      workspaceId: session.workspaceId,
      workflowId: id,
      source: "manual",
      status: "QUEUED",
      ...(input !== undefined ? { input: asInputJson(input) } : {}),
    },
  });

  await runExecution(execution.id);
  return { executionId: execution.id };
}


/**
 * Flip a workflow between DRAFT and ACTIVE.
 *
 * Activation re-validates the *saved* definition rather than trusting it,
 * because the definition on disk may predate a stricter validator — activating
 * without a check would let an old, now-invalid graph start running. Deletion
 * of executions is out of scope; pausing stops new runs, it does not erase
 * history.
 */
export async function setWorkflowStatus(_previous: WorkflowState, formData: FormData): Promise<WorkflowState> {
  const session = await requireSession();
  const id = text(formData, "id");
  const status = text(formData, "status");
  if (!id) return { error: "Missing workflow id." };
  if (status !== "ACTIVE" && status !== "DRAFT") return { error: "Status must be ACTIVE or DRAFT." };

  const workflow = await prisma.workflow.findFirst({ where: { id, workspaceId: session.workspaceId } });
  if (!workflow) return { error: "Workflow not found." };

  if (status === "ACTIVE") {
    const definition = (workflow.definition ?? {}) as { nodes?: unknown };
    const nodes = Array.isArray(definition.nodes) ? definition.nodes : definition;
    const checked = parseDefinition(Array.isArray(nodes) ? { nodes } : nodes);
    if (!checked.ok) return { error: `Cannot activate: ${checked.error}` };
    if (checked.nodes.length === 0) return { error: "Cannot activate an empty workflow." };
  }

  // Activation is where a stored cron becomes a schedule: the sweep only reads rows that
  // are ACTIVE *and* carry a `nextRunAt`, so this is the writer that has to compute it.
  // Pausing clears it, which is what makes a non-null value mean "this will run".
  await prisma.workflow.update({
    where: { id },
    data: { status, nextRunAt: nextRunAtFor(workflow.trigger, status) },
  });
  return { id };
}
