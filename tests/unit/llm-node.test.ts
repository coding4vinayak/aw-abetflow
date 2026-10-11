// Unit tests for the `llm` workflow node. No network, no API key, no DB — the
// point of these is the guard rails, so everything runs against a stub model.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeGraph, type WorkflowDef } from "../../src/lib/executor";
import { parseDefinition } from "../../src/lib/definition";
import { runLlmNode, type LlmCompleteFn } from "../../src/lib/llm-node";

const base = () => ({ vars: {} as Record<string, unknown>, credentials: {} });


/** A stub provider that records what it was asked and replies with `data`. */
function stub(data: unknown): LlmCompleteFn & { calls: number; lastUser?: string } {
  const fn = (async (
    _system: string,
    user: string,
    _options: Parameters<LlmCompleteFn>[2],
  ) => {
    fn.calls++;
    fn.lastUser = user;
    return { data, usage: { totalTokens: 12 } };
  }) as LlmCompleteFn & { calls: number; lastUser?: string };
  fn.calls = 0;
  return fn;
}

describe("llm node config validation", () => {
  it("rejects a missing prompt at save time, not at run time", () => {
    const res = parseDefinition({ nodes: [{ id: "a", type: "llm", config: {} }] });
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.error : "", /prompt/);
  });

  it("requires at least two labels for classify", () => {
    const res = parseDefinition({
      nodes: [{ id: "a", type: "llm", config: { task: "classify", prompt: "go", labels: ["only"] } }],
    });
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.error : "", /at least two labels/);
  });

  it("requires fields[] for extract", () => {
    const res = parseDefinition({
      nodes: [{ id: "a", type: "llm", config: { task: "extract", prompt: "go", fields: [] } }],
    });
    assert.equal(res.ok, false);
  });

  it("accepts a well-formed llm node", () => {
    const res = parseDefinition({
      nodes: [{ id: "a", type: "llm", config: { task: "classify", prompt: "go", labels: ["x", "y"] } }],
    });
    assert.equal(res.ok, true);
  });
});

describe("llm node execution", () => {
  it("classify returns the author's label, case-insensitively matched", async () => {
    const out = await runLlmNode({
      prompt: "Label this ticket",
      input: "my card was stolen",
      config: { task: "classify", labels: ["billing", "fraud"] },
      llmComplete: stub({ label: "FRAUD", confidence: 0.9 }),
    });
    assert.equal((out as { label: string }).label, "fraud");
    assert.equal((out as { confidence: number }).confidence, 0.9);
  });

  it("rejects an invented label instead of passing it downstream", async () => {
    // The single most important test here: a model that ignores its label list
    // must not be able to invent a branch that the workflow then acts on.
    await assert.rejects(
      runLlmNode({
        prompt: "Label this",
        input: "hello",
        config: { task: "classify", labels: ["billing", "fraud"] },
        llmComplete: stub({ label: "something_invented" }),
      }),
      /not one of the configured labels/,
    );
  });

  it("extract copies only the requested fields", async () => {
    const out = await runLlmNode({
      prompt: "Pull the details",
      input: "Jane Doe, jane@example.com, VP Sales",
      config: { task: "extract", fields: ["name", "email"] },
      llmComplete: stub({ name: "Jane Doe", email: "jane@example.com", ssn: "should-not-appear" }),
    });
    const o = out as Record<string, unknown>;
    assert.equal(o.name, "Jane Doe");
    assert.equal(o.email, "jane@example.com");
    assert.equal(o.ssn, undefined, "fields the author did not ask for must not pass through");
  });

  it("truncates oversized input before it reaches the provider", async () => {
    const provider = stub({ result: "ok" });
    await runLlmNode({
      prompt: "Summarise",
      input: "x".repeat(50_000),
      config: { task: "summarize", maxChars: 500 },
      llmComplete: provider,
    });
    assert.ok(provider.lastUser!.includes("[truncated"), "large payloads must be marked as truncated");
    assert.ok(provider.lastUser!.length < 2_000, "truncated payload should be small");
  });

  it("fails loudly when the provider returns nothing — no silent guess", async () => {
    // A workflow run has no human in the loop, so a missing answer must surface
    // to the run's onError/continueOnFail wiring rather than become a guess.
    await assert.rejects(
      runLlmNode({
        prompt: "Summarise",
        input: "text",
        config: { task: "summarize" },
        llmComplete: (async () => null) as unknown as LlmCompleteFn,
      }),
      /returned no result/,
    );
  });

  it("fails when a classify node has fewer than two labels at runtime", async () => {
    await assert.rejects(
      runLlmNode({
        prompt: "Label",
        input: "x",
        config: { task: "classify", labels: ["only"] },
        llmComplete: stub({ label: "only" }),
      }),
      /at least two labels/,
    );
  });
});

describe("llm node inside a graph", () => {
  // The llm node is linear: it emits { label } and follows `next`. Branching
  // on the label is the condition node's job, tested in executor.test.ts.
  // What matters here is failure propagation into the run's own machinery.
  const def: WorkflowDef = {
    nodes: [
      { id: "classify", type: "llm", config: { task: "classify", prompt: "Label", labels: ["urgent", "normal"] }, next: "store" },
      { id: "store", type: "set_variable", config: { name: "saw", value: true } },
    ],
  };

  it("emits the label downstream when the provider answers", async () => {
    const up = await executeGraph(def, { type: "n" }, { ...base(), llmComplete: stub({ label: "urgent" }) });
    assert.equal(up.status, "COMPLETED");
    assert.equal(up.vars.saw, true, "the next node should run on a good classification");
    const step = up.steps.find((s) => s.nodeId === "classify");
    assert.equal(step?.status, "OK");
    assert.equal((step?.output as { label: string }).label, "urgent");
  });

  it("continues past the node when the provider is down and continueOnFail is set", async () => {
    const down = await executeGraph(
      {
        ...def,
        nodes: [{ ...def.nodes[0], continueOnFail: true }, def.nodes[1]],
      },
      { type: "n" },
      { ...base(), llmComplete: (async () => null) as unknown as LlmCompleteFn },
    );
    assert.equal(down.status, "COMPLETED");
    assert.equal(down.vars.saw, true, "the run should continue rather than abort the whole flow");
    assert.ok(down.steps.some((s) => s.nodeId === "classify" && s.status === "FAILED"));
  });

  it("aborts the run when the model is down and continueOnFail is not set", async () => {
    const res = await executeGraph(def, { type: "n" }, { ...base(), llmComplete: (async () => null) as unknown as LlmCompleteFn });
    assert.equal(res.status, "FAILED");
    assert.equal(res.vars.saw, undefined, "downstream node must not run on a failed model call");
  });
});
