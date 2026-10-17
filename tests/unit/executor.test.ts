// Unit tests for the AbetFlow executor: pure graph walks, no server, no DB.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cappedBody, executeGraph, jsonataTruth, renderTemplate } from "../../src/lib/executor";
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

  // The four behaviors below were each a quiet lie before this sweep: the
  // condition disagreed with JSONata, the loop ran zero times for a single
  // item, a second loop erased the first, and JSON responses ignored the
  // documented 8KB body cap. Each test fails on the old shape.
  it("branches on JSONata truth, not JavaScript truth", async () => {
    const def = () => ({
      nodes: [
        { id: "c", type: "condition" as const, config: { expression: "input.items" }, nextTrue: "yes", nextFalse: "no" },
        { id: "yes", type: "note" as const, config: { text: "t" } },
        { id: "no", type: "note" as const, config: { text: "f" } },
      ],
    });
    for (const items of [[], {}, [0], 0, "", null, undefined]) {
      const r = await executeGraph(def(), { items }, ctx());
      assert.equal(r.output, "f", `JSONata says ${JSON.stringify(items)} is false`);
      assert.equal((r.steps[0].output as { result?: boolean }).result, false);
    }
    for (const items of [["x"], { a: 1 }, "x", [0, 1]]) {
      const r = await executeGraph(def(), { items }, ctx());
      assert.equal(r.output, "t", `JSONata says ${JSON.stringify(items)} is true`);
    }
  });

  it("runs a loop once for a singleton, zero times only for nothing", async () => {
    const def = (items: string, doId: string) => ({
      nodes: [
        { id: "t", type: "trigger" as const, next: "l" },
        { id: "l", type: "loop" as const, config: { items, do: doId }, next: "m" },
        { id: "u", type: "transform" as const, config: { expression: "$uppercase(input)" } },
        { id: "n", type: "note" as const, config: { text: "{{input.name}}" } },
        { id: "m", type: "merge" as const },
      ],
    });
    // A bare value (JSONata collapses a one-element sequence) is one item.
    const single = await executeGraph(def("input.words", "u"), { words: "abc" }, ctx());
    assert.equal(single.status, "COMPLETED");
    assert.deepEqual(single.output, ["ABC"]);
    // A filtered single match arrives as the object itself — also one item.
    const collapsed = await executeGraph(def("input.items[name='a']", "n"), { items: [{ name: "a" }] }, ctx());
    assert.deepEqual(collapsed.output, ["a"]);
    // Only a genuinely absent value is no items.
    const none = await executeGraph(def("input.missing", "u"), {}, ctx());
    assert.deepEqual(none.output, []);
    assert.deepEqual(none.steps.find((s) => s.nodeId === "l")?.output, { items: 0 });
  });

  it("reports a truncated loop instead of silently dropping the rest", async () => {
    const result = await executeGraph(
      {
        nodes: [
          { id: "t", type: "trigger", next: "l" },
          { id: "l", type: "loop", config: { items: "input.items", do: "u" }, next: "m" },
          { id: "u", type: "transform", config: { expression: "$uppercase(input)" } },
          { id: "m", type: "merge" },
        ],
      },
      { items: Array.from({ length: 150 }, (_, i) => `i${i}`) },
      ctx(),
    );
    assert.deepEqual(result.steps.find((s) => s.nodeId === "l")?.output, { items: 100, evaluated: 150 });
    assert.equal((result.output as unknown[]).length, 100);
  });

  it("merges what every loop collected, not just the last", async () => {
    const result = await executeGraph(
      {
        nodes: [
          { id: "t", type: "trigger", next: "sv" },
          { id: "sv", type: "set_variable", config: { name: "b", value: ["b1"] }, next: "l1" },
          { id: "l1", type: "loop", config: { items: "input.a", do: "u" }, next: "l2" },
          { id: "l2", type: "loop", config: { items: "$vars.b", do: "u" }, next: "m" },
          { id: "u", type: "transform", config: { expression: "$uppercase(input)" } },
          { id: "m", type: "merge" },
        ],
      },
      { a: ["a1", "a2"] },
      ctx(),
    );
    assert.deepEqual(result.output, ["A1", "A2", "B1"]);
  });
});

describe("jsonataTruth", () => {
  it("matches the engine's own $boolean on the corners JS gets wrong", async () => {
    assert.equal(await jsonataTruth([]), false);
    assert.equal(await jsonataTruth({}), false);
    assert.equal(await jsonataTruth([0]), false);
    assert.equal(await jsonataTruth(0), false);
    assert.equal(await jsonataTruth(""), false);
    assert.equal(await jsonataTruth(null), false);
    assert.equal(await jsonataTruth(undefined), false);
    assert.equal(await jsonataTruth([0, 1]), true);
    assert.equal(await jsonataTruth({ a: 1 }), true);
    assert.equal(await jsonataTruth("x"), true);
  });
});

describe("cappedBody", () => {
  it("parses JSON within the cap", () => {
    assert.deepEqual(cappedBody('{"a":1}'), { a: 1 });
  });
  it("keeps an over-cap JSON document as its text prefix, not as parsed data", () => {
    const big = JSON.stringify({ big: "x".repeat(9000) });
    const body = cappedBody(big);
    assert.equal(typeof body, "string");
    assert.equal((body as string).length, 8000);
  });
  it("caps raw text the same way", () => {
    const body = cappedBody("y".repeat(20000));
    assert.equal(typeof body, "string");
    assert.equal((body as string).length, 8000);
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
