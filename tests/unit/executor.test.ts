// Unit tests for the AbetFlow executor: pure graph walks, no server, no DB.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeGraph, renderTemplate } from "../../src/lib/executor";
import { nextCronRun } from "../../src/lib/cron";

const ctx = () => ({ vars: {} as Record<string, unknown>, credentials: {} });

describe("renderTemplate", () => {
  it("interpolates input and vars, blanks the unknown", () => {
    assert.equal(
      renderTemplate("Hi {{input.name}}, plan {{vars.plan}} {{input.missing}}!", { name: "Ada" }, { plan: "Pro" }),
      "Hi Ada, plan Pro !",
    );
  });
});

describe("executeGraph", () => {
  it("walks a linear chain", async () => {
    const result = await executeGraph(
      {
        nodes: [
          { id: "t", type: "trigger", next: "s" },
          { id: "s", type: "set_variable", config: { name: "greeting", value: "hello {{input.name}}" }, next: "n" },
          { id: "n", type: "note", config: { text: "{{vars.greeting}}" } },
        ],
      },
      { name: "Ada" },
      ctx(),
    );
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.output, "hello Ada");
    assert.equal(result.vars.greeting, "hello Ada");
    assert.deepEqual(result.steps.map((s) => s.nodeType), ["trigger", "set_variable", "note"]);
  });

  it("branches on a condition", async () => {
    const result = await executeGraph(
      {
        nodes: [
          { id: "t", type: "condition", config: { expression: "input.score > 70" }, nextTrue: "hot", nextFalse: "cold" },
          { id: "hot", type: "note", config: { text: "hot lead" } },
          { id: "cold", type: "note", config: { text: "nurture" } },
        ],
      },
      { score: 84 },
      ctx(),
    );
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.output, "hot lead");
  });

  it("fans out a loop and merges", async () => {
    const result = await executeGraph(
      {
        nodes: [
          { id: "t", type: "trigger", next: "l" },
          { id: "l", type: "loop", config: { items: "input.items", do: ["upper"] }, next: "m" },
          { id: "upper", type: "transform", config: { expression: "$uppercase(input)" } },
          { id: "m", type: "merge" },
        ],
      },
      { items: ["a", "b", "c"] },
      ctx(),
    );
    assert.equal(result.status, "COMPLETED");
    assert.deepEqual(result.output, ["A", "B", "C"]);
  });

  it("continues past a failing node when asked", async () => {
    const result = await executeGraph(
      {
        nodes: [
          { id: "t", type: "trigger", next: "bad" },
          { id: "bad", type: "http_request", config: { url: "https://no-such-host.invalid/" }, continueOnFail: true, next: "n" },
          { id: "n", type: "note", config: { text: "survived" } },
        ],
      },
      {},
      ctx(),
    );
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.output, "survived");
    assert.ok(result.steps.some((s) => s.nodeId === "bad" && s.status === "FAILED"));
  });

  it("fails honestly on an unknown node type", async () => {
    const result = await executeGraph(
      { nodes: [{ id: "t", type: "trigger", next: "x" }, { id: "x", type: "teleport" as never }] },
      {},
      ctx(),
    );
    assert.equal(result.status, "FAILED");
    assert.match(result.error ?? "", /Unknown node type/);
  });

  it("stops a cycle at the step budget", async () => {
    const result = await executeGraph(
      {
        nodes: [
          { id: "a", type: "note", config: { text: "a" }, next: "b" },
          { id: "b", type: "note", config: { text: "b" }, next: "a" },
        ],
      },
      {},
      ctx(),
    );
    assert.equal(result.status, "FAILED");
    assert.match(result.error ?? "", /Step budget/);
  });
});

describe("nextCronRun", () => {
  it("finds the next minute tick", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    assert.equal(nextCronRun("* * * * *", from)?.toISOString(), "2026-01-01T00:01:00.000Z");
  });

  it("respects daily schedules", () => {
    const from = new Date("2026-01-01T10:00:00Z");
    assert.equal(nextCronRun("0 9 * * *", from)?.toISOString(), "2026-01-02T09:00:00.000Z");
  });

  it("rejects impossible dates", () => {
    assert.equal(nextCronRun("0 0 30 2 *", new Date("2026-01-01T00:00:00Z")), null);
  });

  it("rejects malformed expressions", () => {
    assert.equal(nextCronRun("not a cron", new Date()), null);
  });
});
