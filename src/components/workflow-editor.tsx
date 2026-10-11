"use client";

import { useState } from "react";
import { useActionState } from "react";
import { updateWorkflowDefinition, runWorkflowNow } from "@/app/workflow-actions";

/**
 * The workflow builder.
 *
 * A structured editor rather than a drag-and-drop canvas, and the choice is
 * deliberate rather than aspirational: every node type, its config shape, and
 * its wiring is explicit in a form, and what is saved is exactly what the API
 * accepts — validated by the same `parseDefinition` the routes use. A canvas
 * would be prettier and less honest about the graph it produces; this one
 * cannot build what cannot run.
 */

export interface EditorNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  next?: string;
  nextTrue?: string;
  nextFalse?: string;
  onError?: string;
  continueOnFail?: boolean;
}

const NODE_TYPES = [
  "trigger",
  "http_request",
  "transform",
  "condition",
  "set_variable",
  "delay",
  "loop",
  "merge",
  "llm",
  "note",
] as const;

/** Which config keys each type actually reads, so the editor never invents one. */
const FIELDS: Record<string, { key: string; label: string; kind: "text" | "area" | "number" | "select" }[]> = {
  note: [{ key: "text", label: "Note text", kind: "area" }],
  set_variable: [
    { key: "name", label: "Variable name", kind: "text" },
    { key: "value", label: "Value (JSON, templates allowed)", kind: "area" },
  ],
  transform: [{ key: "expression", label: "JSONata expression over {input, vars}", kind: "area" }],
  condition: [{ key: "expression", label: "JSONata truth test", kind: "area" }],
  http_request: [
    { key: "method", label: "Method", kind: "select" },
    { key: "url", label: "URL (templates allowed, https only)", kind: "text" },
    { key: "headers", label: "Headers (JSON object)", kind: "area" },
    { key: "body", label: "Body (JSON, sent on POST/PUT/PATCH)", kind: "area" },
  ],
  delay: [{ key: "seconds", label: "Seconds to wait (max 300)", kind: "number" }],
  loop: [
    { key: "items", label: "Items (JSONata expression returning a list)", kind: "area" },
    { key: "do", label: "Node id(s) to run per item, comma-separated", kind: "text" },
  ],
  llm: [
    { key: "task", label: "Task", kind: "select" },
    { key: "prompt", label: "Prompt (templated with {input, vars})", kind: "area" },
    { key: "labels", label: "Labels for classify, comma-separated (2+)", kind: "text" },
    { key: "fields", label: "Fields for extract, comma-separated", kind: "text" },
    { key: "model", label: "Model (blank = account default)", kind: "text" },
  ],
};

const SELECT_OPTIONS: Record<string, string[]> = {
  method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
  task: ["classify", "extract", "summarize", "transform"],
};

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function parseValue(raw: string, key: string): unknown {
  // Numbers stay numbers; JSON parses as JSON; everything else is text.
  // A field that looks like JSON but is not (a template with braces) stays
  // text, because forcing it through JSON.parse would corrupt it.
  if (/^(seconds|maxChars)$/.test(key)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  const t = raw.trim();
  if (t === "") return undefined;
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  if (t === "true") return true;
  if (t === "false") return false;
  const n = Number(t);
  if (t !== "" && Number.isFinite(n) && /^[-+]?\d+(\.\d+)?$/.test(t)) return n;
  return raw;
}

function listValue(raw: string): unknown {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function WorkflowEditor({
  workflowId,
  initialNodes,
  initialName,
}: {
  workflowId: string;
  initialNodes: EditorNode[];
  initialName: string;
}) {
  const [nodes, setNodes] = useState<EditorNode[]>(initialNodes);
  const [name, setName] = useState(initialName);
  const [saveState, saveAction] = useActionState(updateWorkflowDefinition, {});
  const [runState, runAction] = useActionState(runWorkflowNow, {});
  const [sampleInput, setSampleInput] = useState('{"hello":"world"}');
  const [open, setOpen] = useState<string | null>(initialNodes[0]?.id ?? null);

  function patch(id: string, change: Partial<EditorNode>) {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, ...change } : n)));
  }

  function setConfig(id: string, key: string, raw: string, special?: "list") {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const value = special === "list" ? listValue(raw) : parseValue(raw, key);
    const config = { ...(node.config ?? {}) };
    if (value === undefined) delete config[key];
    else config[key] = value;
    patch(id, { config });
  }

  function addNode() {
    const id = `node-${nodes.length + 1}`;
    const taken = new Set(nodes.map((n) => n.id));
    let candidate = id;
    let i = 1;
    while (taken.has(candidate)) {
      i += 1;
      candidate = `node-${nodes.length + i}`;
    }
    setNodes((ns) => [...ns, { id: candidate, type: "note", config: { text: "" } }]);
    setOpen(candidate);
  }

  function removeNode(id: string) {
    setNodes((ns) =>
      ns
        .filter((n) => n.id !== id)
        .map((n) => {
          const cleaned = { ...n };
          if (cleaned.next === id) delete cleaned.next;
          if (cleaned.nextTrue === id) delete cleaned.nextTrue;
          if (cleaned.nextFalse === id) delete cleaned.nextFalse;
          return cleaned;
        }),
    );
    if (open === id) setOpen(null);
  }

  const ids = nodes.map((n) => n.id);

  return (
    <div className="space-y-6">
      <form action={saveAction} className="space-y-6">
        <input type="hidden" name="id" value={workflowId} />
        <div>
          <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
            Workflow name
          </label>
          <input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full max-w-md rounded-md border border-gray-300 bg-white px-3 py-2 text-[14px] font-semibold text-gray-900 focus:border-gray-500 focus:outline-none"
          />
        </div>

        <input type="hidden" name="definition" value={JSON.stringify({ nodes })} />

        {saveState.error && (
          <p role="alert" className="max-w-2xl rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-gray-800">
            {saveState.error}
          </p>
        )}
        {saveState.id && (
          <p className="max-w-2xl rounded-md border border-green-200 bg-green-50 px-3 py-2 text-[12px] text-gray-800">
            Saved.
          </p>
        )}

        <div className="space-y-3">
          {nodes.map((node, index) => {
            const isOpen = open === node.id;
            const fields = FIELDS[node.type] ?? [];
            return (
              <div key={node.id} className="max-w-3xl rounded-2xl border border-gray-200 bg-white shadow-sm">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : node.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <span className="rounded-full bg-gray-100 px-2.5 py-0.5 font-mono text-[11px] text-gray-600">
                    {index + 1}
                  </span>
                  <span className="rounded-full bg-gray-900 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                    {node.type}
                  </span>
                  <span className="truncate font-mono text-[12px] text-gray-500">{node.id}</span>
                  <span className="ml-auto text-gray-400">{isOpen ? "▾" : "▸"}</span>
                </button>

                {isOpen && (
                  <div className="space-y-3 border-t border-gray-100 px-4 py-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
                          Node id
                        </span>
                        <input
                          value={node.id}
                          onChange={(e) => {
                            const next = e.target.value.trim().replace(/\s+/g, "-");
                            if (!next || next === node.id || ids.includes(next)) return;
                            const old = node.id;
                            setNodes((ns) =>
                              ns.map((n) => {
                                if (n.id === old) return { ...n, id: next };
                                const c = { ...n };
                                if (c.next === old) c.next = next;
                                if (c.nextTrue === old) c.nextTrue = next;
                                if (c.nextFalse === old) c.nextFalse = next;
                                return c;
                              }),
                            );
                            setOpen(next);
                          }}
                          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-[12px] text-gray-900 focus:border-gray-500 focus:outline-none"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
                          Type
                        </span>
                        <select
                          value={node.type}
                          onChange={(e) => patch(node.id, { type: e.target.value, config: {} })}
                          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 focus:border-gray-500 focus:outline-none"
                        >
                          {NODE_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {fields.map((f) => {
                      const raw = str(node.config?.[f.key]);
                      const display =
                        (f.key === "labels" || f.key === "fields") && Array.isArray(node.config?.[f.key])
                          ? (node.config?.[f.key] as string[]).join(", ")
                          : raw;
                      return (
                        <label key={f.key} className="block">
                          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
                            {f.label}
                          </span>
                          {f.kind === "select" ? (
                            <select
                              value={display}
                              onChange={(e) => setConfig(node.id, f.key, e.target.value)}
                              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 focus:border-gray-500 focus:outline-none"
                            >
                              {(SELECT_OPTIONS[f.key] ?? []).map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </select>
                          ) : f.kind === "area" ? (
                            <textarea
                              value={display}
                              onChange={(e) =>
                                setConfig(node.id, f.key, e.target.value, f.key === "labels" || f.key === "fields" ? "list" : undefined)
                              }
                              rows={f.key === "prompt" || f.key === "expression" ? 5 : 2}
                              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-[12px] text-gray-900 focus:border-gray-500 focus:outline-none"
                            />
                          ) : (
                            <input
                              value={display}
                              onChange={(e) => setConfig(node.id, f.key, e.target.value)}
                              type={f.kind === "number" ? "number" : "text"}
                              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-[12px] text-gray-900 focus:border-gray-500 focus:outline-none"
                            />
                          )}
                        </label>
                      );
                    })}

                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
                          Next
                        </span>
                        <select
                          value={node.next ?? ""}
                          onChange={(e) => patch(node.id, { next: e.target.value || undefined })}
                          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-[12px] text-gray-900 focus:border-gray-500 focus:outline-none"
                        >
                          <option value="">(end)</option>
                          {ids.filter((i) => i !== node.id).map((i) => (
                            <option key={i} value={i}>
                              {i}
                            </option>
                          ))}
                        </select>
                      </label>
                      {node.type === "condition" && (
                        <>
                          <label className="block">
                            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
                              When true
                            </span>
                            <select
                              value={node.nextTrue ?? ""}
                              onChange={(e) => patch(node.id, { nextTrue: e.target.value || undefined })}
                              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-[12px] text-gray-900 focus:border-gray-500 focus:outline-none"
                            >
                              <option value="">(end)</option>
                              {ids.filter((i) => i !== node.id).map((i) => (
                                <option key={i} value={i}>
                                  {i}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
                              When false
                            </span>
                            <select
                              value={node.nextFalse ?? ""}
                              onChange={(e) => patch(node.id, { nextFalse: e.target.value || undefined })}
                              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-[12px] text-gray-900 focus:border-gray-500 focus:outline-none"
                            >
                              <option value="">(end)</option>
                              {ids.filter((i) => i !== node.id).map((i) => (
                                <option key={i} value={i}>
                                  {i}
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      )}
                    </div>

                    <label className="flex items-center gap-2 text-[12px] text-gray-600">
                      <input
                        type="checkbox"
                        checked={node.continueOnFail ?? false}
                        onChange={(e) => patch(node.id, { continueOnFail: e.target.checked || undefined })}
                      />
                      Keep going if this node fails (uses <code className="font-mono">onError</code>)
                    </label>

                    <button
                      type="button"
                      onClick={() => removeNode(node.id)}
                      className="text-[12px] font-medium text-red-600 hover:text-red-800"
                    >
                      Remove this node
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={addNode}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-[12px] font-semibold text-gray-700 hover:bg-gray-50"
          >
            + Add node
          </button>
          <button
            type="submit"
            className="rounded-md bg-gray-900 px-5 py-2 text-[12px] font-semibold text-white hover:bg-gray-700"
          >
            Save workflow
          </button>
        </div>
      </form>

      <form action={runAction} className="max-w-3xl rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <input type="hidden" name="id" value={workflowId} />
        <h2 className="text-sm font-semibold text-gray-900">Try it</h2>
        <p className="mt-1 text-[12px] text-gray-600">
          Runs the saved workflow now, synchronously, and shows the trace. The workflow must be ACTIVE and manual.
        </p>
        {runState.error && (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-gray-800">
            {runState.error}
          </p>
        )}
        {runState.executionId && (
          <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-[12px] text-gray-800">
            Ran as execution <code className="font-mono">{runState.executionId}</code>.{" "}
            <a href={`/workflows/${workflowId}/runs/${runState.executionId}`} className="underline underline-offset-2">
              View the trace
            </a>
          </p>
        )}
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
            Sample input (JSON)
          </span>
          <textarea
            name="input"
            value={sampleInput}
            onChange={(e) => setSampleInput(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-[12px] text-gray-900 focus:border-gray-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          className="mt-3 rounded-md bg-cyan-600 px-4 py-2 text-[12px] font-semibold text-white hover:bg-cyan-700"
        >
          Run now
        </button>
      </form>
    </div>
  );
}
