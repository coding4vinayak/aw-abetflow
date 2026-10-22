/**
 * The first run — run with:  npm run check:first-run
 *
 * WHY THIS EXISTS
 *
 * A new workspace used to start on an empty dashboard whose only advice was
 * "create one via `POST /api/workflows`" — advice for a buyer who already
 * writes code. So a new workspace now gets one example workflow that has
 * already run, and one click that takes it away again.
 *
 * The unit tests cover the graph (it really runs, and it routes the way it
 * says). They cannot cover the two things that are easiest to get wrong and
 * most expensive to get wrong:
 *
 *   1. **Idempotency.** A double-click must not stack two copies of the same
 *      flow, and a retried request must not either.
 *   2. **Removal scope.** "One click" must never mean "and your data too".
 *
 * So this script builds a throwaway database on the configured Postgres from
 * the committed migrations, loads the example, loads it again, adds a flow of
 * the customer's own, removes the example, and checks what is left.
 *
 * Needs a reachable Postgres: docker compose locally, the service container in
 * CI.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let passed = 0;
const failures: string[] = [];

function ok(label: string, condition: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    ok(label, true);
  } else {
    ok(`${label} — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`, false);
  }
}

// A per-run database on the configured server, so parallel or crashed runs never
// collide and the drop at the end is the whole cleanup. CREATE DATABASE cannot run
// inside a transaction, which is why this is a plain pool and not the app client.
const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://abetflow:abetflow@localhost:5432/abetflow";
const scratchName = `check_first_run_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const server = new Pool({ connectionString: baseUrl });
await server.query(`CREATE DATABASE "${scratchName}"`);

const scratchUrl = (() => {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${scratchName}`;
  parsed.searchParams.delete("schema");
  return parsed.toString();
})();
process.env.DATABASE_URL = scratchUrl;

// The schema a deploy would create, from the committed migration history.
execFileSync(path.join(ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
  cwd: ROOT,
  env: process.env,
  stdio: "ignore",
});

const { prisma } = await import("../src/lib/db");
const { EXAMPLE_WORKFLOW_NAME, loadExampleWorkflow, removeExampleWorkflow } = await import(
  "../src/lib/example-workflow"
);

try {
  const workspace = await prisma.workspace.create({
    data: { name: "First-run check", slug: `first-run-${Date.now()}` },
  });

  // ── the first load ─────────────────────────────────────────────────────
  const first = await loadExampleWorkflow(workspace.id);
  eq("the first load creates the example", first.created, true);
  eq("…and the run finished", first.status, "COMPLETED");
  ok("…and it left a step trace", (first.steps ?? 0) >= 4, `steps: ${first.steps}`);

  const workflow = await prisma.workflow.findFirst({
    where: { workspaceId: workspace.id, name: EXAMPLE_WORKFLOW_NAME },
    include: { executions: { include: { steps: true } } },
  });
  ok("the workflow is there", !!workflow);
  eq("…with one execution", workflow?.executions.length, 1);
  eq("…whose output is the routed deal", JSON.stringify(workflow?.executions[0].output), JSON.stringify({
    tag: "routed",
    route: "enterprise",
    company: "Example Co",
  }));
  ok("…and a step per node", (workflow?.executions[0].steps.length ?? 0) >= 4);
  eq("…all of them OK", workflow?.executions[0].steps.every((s) => s.status === "OK"), true);
  eq("…and the version history is there too", await prisma.workflowVersion.count({ where: { workflowId: workflow!.id } }), 1);

  // ── the second load must not stack a copy ──────────────────────────────
  const second = await loadExampleWorkflow(workspace.id);
  eq("a second load changes nothing", second.created, false);
  eq("…there is still one workflow", await prisma.workflow.count({ where: { workspaceId: workspace.id } }), 1);
  eq("…and still one run", await prisma.execution.count({ where: { workspaceId: workspace.id } }), 1);

  // ── the removal must not touch anything else ───────────────────────────
  const own = await prisma.workflow.create({
    data: {
      workspaceId: workspace.id,
      name: "My real flow",
      trigger: { kind: "manual" },
      definition: { nodes: [{ id: "n", type: "note", config: { text: "mine" } }] },
      status: "DRAFT",
    },
  });

  const removed = await removeExampleWorkflow(workspace.id);
  eq("the removal removes the example", removed.removed, 1);
  eq("…and counts the run it took with it", removed.executions, 1);

  const left = await prisma.workflow.findMany({ where: { workspaceId: workspace.id } });
  eq("the customer's own flow is still there", left.length, 1);
  eq("…and it is theirs", left[0].id, own.id);
  eq("the example is gone", left.some((w) => w.name === EXAMPLE_WORKFLOW_NAME), false);
  eq("its executions are gone", await prisma.execution.count({ where: { workspaceId: workspace.id } }), 0);
  eq("its step traces are gone", await prisma.executionStep.count({ where: { execution: { workspaceId: workspace.id } } }), 0);
  eq("its version history is gone", await prisma.workflowVersion.count({ where: { workflow: { workspaceId: workspace.id } } }), 0);

  // ── and removing what is not there is a no-op ──────────────────────────
  const again = await removeExampleWorkflow(workspace.id);
  eq("removing it twice removes nothing the second time", again.removed, 0);
  eq("…and the customer's flow is still there", await prisma.workflow.count({ where: { workspaceId: workspace.id } }), 1);
} finally {
  await server.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await server.end();
}

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`\n  Failed: ${failures.join("; ")}`);
  process.exit(1);
}
