import { prisma } from "./db";
import { runExecution } from "./runner";
import { nextRunAtFor } from "./cron";
import type { WorkflowDef } from "./executor";

/**
 * The example workflow: what a new workspace loads, and the way to take it
 * away again.
 *
 * This app had a public demo workspace with a real workflow in it, and a first
 * run that showed an empty screen and the advice "create one via
 * `POST /api/workflows`" — advice for a buyer who already writes code. A
 * signup that starts on an empty dashboard ends on a cancelled subscription,
 * so the first thing a new workspace gets is one workflow that has already
 * **run**, with the trace to prove it.
 *
 * Two rules, the same ones the other apps in the suite follow:
 *
 * 1. It is example data, and it says so. The workflow is named "Example: …",
 *    its description says so, and the card on the dashboard says so.
 * 2. One click removes it, and removes *only* it. The removal finds the
 *    workflow by its exact name, and the delete cascades to that workflow's
 *    versions, its executions and their step traces — never to anything the
 *    customer made.
 */

/** The name is the marker: the removal path finds the example by it. */
export const EXAMPLE_WORKFLOW_NAME = "Example: inbound lead triage";

export const EXAMPLE_WORKFLOW_DESCRIPTION =
  "Example data — a lead arrives, is read, and is routed by size.";

/** The input the example run is given. The company is obviously an example. */
export const EXAMPLE_WORKFLOW_INPUT = { name: "Example Co", seats: 80 };

/**
 * The graph the example runs.
 *
 * Every node here is one that needs nothing outside this app: a trigger, two
 * variable reads, a condition and a transform. That is deliberate — the
 * example must run in a fresh workspace with no credentials, no SMTP server
 * and no HTTP endpoint, and still finish with a real trace.
 */
export const EXAMPLE_WORKFLOW_DEFINITION: WorkflowDef = {
  nodes: [
    { id: "start", type: "trigger", next: "company" },
    {
      id: "company",
      type: "set_variable",
      config: { name: "company", value: "{{input.name}}" },
      next: "route",
    },
    {
      id: "route",
      type: "condition",
      // `input.seats`, not `vars.seats`: a rendered template is a string, and
      // JSONata will not compare a string with a number. The raw number in the
      // input is what a size comparison has to read.
      config: { expression: "input.seats > 20" },
      nextTrue: "enterprise",
      nextFalse: "standard",
    },
    {
      id: "enterprise",
      type: "transform",
      config: { expression: "{'route': 'enterprise', 'company': vars.company}" },
      next: "tag",
    },
    {
      id: "standard",
      type: "transform",
      config: { expression: "{'route': 'standard', 'company': vars.company}" },
      next: "tag",
    },
    {
      id: "tag",
      type: "set_variable",
      config: { name: "tag", value: "routed" },
    },
  ],
};

/** True when a workflow is the example one. */
export function isExampleWorkflow(name: string): boolean {
  return name === EXAMPLE_WORKFLOW_NAME;
}

/**
 * Load the example workflow into a workspace, and run it once.
 *
 * Idempotent: a second call finds the example already there and changes
 * nothing, so a double-click (or a retried request) cannot stack two copies
 * of the same flow. The removal path is the way back to an empty workspace.
 */
export async function loadExampleWorkflow(workspaceId: string) {
  const existing = await prisma.workflow.findFirst({
    where: { workspaceId, name: EXAMPLE_WORKFLOW_NAME },
    select: { id: true },
  });
  if (existing) {
    const runs = await prisma.execution.count({ where: { workflowId: existing.id } });
    return { created: false, workflowId: existing.id, executionId: null, status: null, steps: 0, runs };
  }

  const trigger = { kind: "manual" } as const;
  const workflow = await prisma.workflow.create({
    data: {
      workspaceId,
      name: EXAMPLE_WORKFLOW_NAME,
      description: EXAMPLE_WORKFLOW_DESCRIPTION,
      trigger,
      definition: EXAMPLE_WORKFLOW_DEFINITION as unknown as object,
      status: "ACTIVE",
      // One computation, shared with every other writer of `trigger`/`status`:
      // the column is what the cron sweep reads, and a writer that forgets it
      // leaves a workflow that can never fire. A manual trigger gets null on
      // purpose — see `nextRunAtFor`.
      nextRunAt: nextRunAtFor(trigger, "ACTIVE"),
    },
  });

  // The version row is the flow's rollback history, and a workflow that lost
  // it has nothing to roll back to.
  await prisma.workflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: 1,
      trigger: { kind: "manual" },
      definition: EXAMPLE_WORKFLOW_DEFINITION as unknown as object,
      note: "Example workflow, version 1",
    },
  });

  // Run it through the real runner — the same runner a manual run, a webhook
  // and a cron all use — so the workspace has a real execution and a real step
  // trace rather than a promise of one.
  const execution = await prisma.execution.create({
    data: {
      workspaceId,
      workflowId: workflow.id,
      source: "manual",
      status: "QUEUED",
      input: EXAMPLE_WORKFLOW_INPUT,
    },
  });
  await runExecution(execution.id);

  const done = await prisma.execution.findUnique({
    where: { id: execution.id },
    include: { steps: { orderBy: { position: "asc" } } },
  });

  return {
    created: true,
    workflowId: workflow.id,
    executionId: execution.id,
    status: done?.status ?? null,
    steps: done?.steps.length ?? 0,
    runs: 1,
  };
}

/**
 * Remove the example workflow, and only the example workflow.
 *
 * The workflow is found by its exact name, so a customer's own flow is never
 * touched, and the delete cascades to that workflow's versions, executions and
 * step traces — which is what makes "one click" honest.
 */
export async function removeExampleWorkflow(workspaceId: string) {
  const workflow = await prisma.workflow.findFirst({
    where: { workspaceId, name: EXAMPLE_WORKFLOW_NAME },
    select: { id: true },
  });
  if (!workflow) return { removed: 0, executions: 0 };

  const executions = await prisma.execution.count({ where: { workflowId: workflow.id } });
  await prisma.workflow.delete({ where: { id: workflow.id } });
  return { removed: 1, executions };
}
