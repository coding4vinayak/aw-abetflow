import { prisma } from "../src/lib/db";
import { runExecution } from "../src/lib/runner";
import { mintApiKey } from "../src/lib/apikeys";

/**
 * Create the demo row only if it is not there yet. Workflow has no unique
 * constraint on name (only Tool/Credential/Variable carry
 * @@unique([workspaceId, name])), so this cannot be an upsert — the lookup is
 * the findFirst and the demo workspace is the scope. Without it, every
 * `npm run db:seed` added another copy of the demo flow.
 */
async function once<T>(label: string, find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  const existing = await find();
  if (existing) {
    console.log(`Already present: ${label}`);
    return existing;
  }
  const created = await create();
  console.log(`Created: ${label}`);
  return created;
}

async function main() {
  console.log("Seeding AbetFlow...");

  const workspace = await prisma.workspace.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "Demo Workspace", slug: "demo" },
  });
  console.log("Workspace:", workspace.id);

  await prisma.variable.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "team_name" } },
    update: { value: "Acme Revenue Team" },
    create: { workspaceId: workspace.id, name: "team_name", value: "Acme Revenue Team" },
  });

  const definition = {
    nodes: [
      { id: "start", type: "trigger" as const, next: "who" },
      { id: "who", type: "set_variable" as const, config: { name: "customer", value: "{{input.name}}" }, next: "vip" },
      {
        id: "vip",
        type: "condition" as const,
        config: { expression: "input.seats > 20" },
        nextTrue: "big",
        nextFalse: "small",
      },
      { id: "big", type: "transform" as const, config: { expression: "'Enterprise deal for ' & vars.customer" } },
      { id: "small", type: "transform" as const, config: { expression: "'SMB deal for ' & vars.customer" } },
    ],
  };

  const workflow = await once(
    "workflow Deal triage demo",
    () => prisma.workflow.findFirst({ where: { workspaceId: workspace.id, name: "Deal triage demo" } }),
    () => prisma.workflow.create({
      data: {
        workspaceId: workspace.id,
        name: "Deal triage demo",
        description: "Routes big deals up, everyone else to the standard path.",
        trigger: { kind: "manual" },
        definition,
        status: "ACTIVE",
      },
    }),
  );
  // The version is the demo flow's rollback history, and a workflow that lost it
  // (an interrupted run, or one seeded before this guard existed) has nothing to
  // roll back to — so the guard repairs it rather than only skipping the insert.
  await once(
    "workflow version 1",
    () => prisma.workflowVersion.findFirst({ where: { workflowId: workflow.id, version: 1 } }),
    () => prisma.workflowVersion.create({
      data: { workflowId: workflow.id, version: 1, trigger: { kind: "manual" }, definition, note: "Initial version" },
    }),
  );
  console.log("Workflow:", workflow.id);

  const execution = await once(
    "seed demo execution",
    () => prisma.execution.findFirst({ where: { workflowId: workflow.id, source: "manual" } }),
    () => prisma.execution.create({
      data: {
        workspaceId: workspace.id,
        workflowId: workflow.id,
        source: "manual",
        status: "QUEUED",
        input: { name: "Meridian Corp", seats: 80 },
      },
    }),
  );
  if (execution.status === "QUEUED") await runExecution(execution.id);
  const done = await prisma.execution.findUnique({
    where: { id: execution.id },
    include: { steps: { orderBy: { position: "asc" } } },
  });
  console.log("Seed execution:", done?.status, "-", JSON.stringify(done?.output));
  console.log("Steps:", done?.steps?.map((s) => `${s.nodeId}:${s.status}`).join(" "));

  
  // Demo API key for smoke tests and the live demo. The plaintext prints once
  // here and is never stored — copy it into smoke scripts, then rotate it.
  await prisma.apiKey.deleteMany({ where: { workspaceId: workspace.id, name: "Demo key" } });
  const demoKey = await mintApiKey(workspace.id, "Demo key");
  console.log("Demo key (copy now, never shown again):", demoKey.plaintext);
console.log("Seeding complete!");
  console.log(`Workflow: ${workflow.id} (workspace demo)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
