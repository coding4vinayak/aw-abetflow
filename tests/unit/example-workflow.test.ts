// The example workflow: the flow a new workspace loads, and the rules that
// keep it from ever being mistaken for the customer's own.
//
// This is a conversion feature with a data-safety edge, so both halves are
// pinned here: the graph really runs (so the trace on the screen is the
// engine's own, not a drawing of one) and the removal is narrow (so "one
// click" can never mean "and your data too").
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executeGraph } from "../../src/lib/executor";
import { parseDefinition } from "../../src/lib/definition";
import {
  EXAMPLE_WORKFLOW_DEFINITION,
  EXAMPLE_WORKFLOW_DESCRIPTION,
  EXAMPLE_WORKFLOW_INPUT,
  EXAMPLE_WORKFLOW_NAME,
  isExampleWorkflow,
} from "../../src/lib/example-workflow";

const ctx = () => ({ vars: {} as Record<string, unknown>, credentials: {} });

describe("the example workflow", () => {
  it("is a graph the app's own parser accepts", () => {
    const parsed = parseDefinition(EXAMPLE_WORKFLOW_DEFINITION);
    assert.equal(parsed.ok, true, "the example must be a definition the product would accept");
  });

  it("runs, and finishes, with no credentials and no outside service", async () => {
    const result = await executeGraph(EXAMPLE_WORKFLOW_DEFINITION, EXAMPLE_WORKFLOW_INPUT, ctx());
    assert.equal(result.status, "COMPLETED");
    // Every node leaves a step behind — the trace is the product.
    assert.deepEqual(
      result.steps.map((s) => `${s.nodeId}:${s.status}`),
      ["start:OK", "company:OK", "route:OK", "enterprise:OK", "tag:OK"],
    );
  });

  it("routes a big deal up and a small one to the standard path", async () => {
    const big = await executeGraph(EXAMPLE_WORKFLOW_DEFINITION, { name: "Example Co", seats: 80 }, ctx());
    assert.deepEqual(big.output, { tag: "routed", route: "enterprise", company: "Example Co" });

    const small = await executeGraph(EXAMPLE_WORKFLOW_DEFINITION, { name: "Example Co", seats: 5 }, ctx());
    assert.deepEqual(small.output, { tag: "routed", route: "standard", company: "Example Co" });
  });

  it("reads the size as a number, not as a rendered string", async () => {
    // A rendered template is a string, and JSONata will not compare a string
    // with a number — so a condition that read `vars.seats` would silently
    // take the wrong branch for every deal. This pins the right source.
    const result = await executeGraph(EXAMPLE_WORKFLOW_DEFINITION, { name: "Example Co", seats: 80 }, ctx());
    assert.equal((result.output as { route: string }).route, "enterprise");
  });

  it("says on its face that it is example data", () => {
    assert.ok(EXAMPLE_WORKFLOW_NAME.startsWith("Example: "), "the name is the marker the removal finds");
    assert.match(EXAMPLE_WORKFLOW_DESCRIPTION, /Example data/);
    assert.equal(EXAMPLE_WORKFLOW_INPUT.name, "Example Co");
  });

  it("is found by its exact name and nothing else", () => {
    assert.equal(isExampleWorkflow(EXAMPLE_WORKFLOW_NAME), true);
    assert.equal(isExampleWorkflow("Example: inbound lead triage "), false, "a trailing space is a different name");
    assert.equal(isExampleWorkflow("Example"), false);
    assert.equal(isExampleWorkflow("My example: inbound lead triage"), false);
    assert.equal(isExampleWorkflow("inbound lead triage"), false);
  });
});

describe("the first-run path", () => {
  it("loads and removes through one door, the way the dashboard calls it", () => {
    const route = readFileSync(new URL("../../src/app/api/example-workflow/route.ts", import.meta.url), "utf8");
    assert.ok(route.includes("loadExampleWorkflow"), "POST must load");
    assert.ok(route.includes("removeExampleWorkflow"), "DELETE must remove");
    assert.ok(route.includes("getSession"), "the door is a session as well as a key");
    assert.ok(route.includes("authedWorkspaceId"), "a key is a door too");
  });

  it("offers the example on the dashboard, and says it can be taken away", () => {
    const card = readFileSync(new URL("../../src/components/example-workflow-card.tsx", import.meta.url), "utf8");
    assert.ok(card.includes("/api/example-workflow"));
    assert.ok(card.includes("Remove the example workflow"), "the way back has to be on the panel");
    assert.ok(card.includes("example data"), "the panel has to say what it is");

    const dashboard = readFileSync(new URL("../../src/app/dashboard/page.tsx", import.meta.url), "utf8");
    assert.ok(dashboard.includes("ExampleWorkflowCard"), "the dashboard must offer it");
    assert.ok(dashboard.includes("isExampleWorkflow"), "and recognise it when it is loaded");
  });
});
