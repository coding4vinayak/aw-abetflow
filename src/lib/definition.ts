import { nextCronRun } from "./cron";
import type { FlowNode } from "./executor";

/**
 * The workflow *graph* validator: what a trigger may hold and whether a set of
 * nodes is a runnable flow. It is not the request-boundary check — that is
 * `./validate.ts`, which owns the shape of a JSON body. This file was called
 * `validate.ts` until the boundary engine took the family name.
 */

const NODE_TYPES = new Set([
  "trigger",
  "http_request",
  "transform",
  "condition",
  "set_variable",
  "delay",
  "loop",
  "merge",
  "note",
  "llm",
]);

export interface TriggerShape {
  kind: string;
  path?: string;
  secret?: string;
  public?: boolean;
  cron?: string;
}

export function parseTrigger(raw: unknown): { ok: true; trigger: TriggerShape } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "trigger must be an object" };
  }
  const t = raw as Record<string, unknown>;
  if (t.kind === "manual") return { ok: true, trigger: { kind: "manual" } };
  if (t.kind === "webhook") {
    const path = typeof t.path === "string" ? t.path.replace(/^\/+|\/+$/g, "") : "";
    if (!path) return { ok: false, error: "webhook trigger needs a path" };
    if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(path)) return { ok: false, error: "webhook path uses [a-z0-9/_-]" };
    const secret = typeof t.secret === "string" && t.secret ? t.secret : undefined;
    // A webhook trigger with no secret is an open POST endpoint that runs that
    // tenant's workflow — the URL is guessable and the path is on the workflow
    // page. So a secret is required unless the author says out loud that the
    // endpoint is meant to be public.
    if (!secret && t.public !== true) {
      return { ok: false, error: "webhook trigger needs a secret (8+ characters), or set public: true to accept unauthenticated calls" };
    }
    if (secret && secret.length < 8) {
      return { ok: false, error: "webhook trigger secret must be at least 8 characters" };
    }
    return {
      ok: true,
      trigger: { kind: "webhook", path, ...(secret ? { secret } : {}), ...(t.public === true ? { public: true } : {}) },
    };
  }
  if (t.kind === "cron") {
    if (typeof t.cron !== "string" || !nextCronRun(t.cron)) {
      return { ok: false, error: "cron trigger needs a valid 5-field expression" };
    }
    return { ok: true, trigger: { kind: "cron", cron: t.cron } };
  }
  return { ok: false, error: "trigger.kind must be manual, webhook or cron" };
}

export function parseDefinition(raw: unknown): { ok: true; nodes: FlowNode[] } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "definition must be an object with nodes" };
  }
  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { ok: false, error: "definition.nodes must be a non-empty array" };
  }
  const ids = new Set<string>();
  for (const n of nodes) {
    if (typeof n !== "object" || n === null || Array.isArray(n)) return { ok: false, error: "each node must be an object" };
    const node = n as Record<string, unknown>;
    if (typeof node.id !== "string" || !node.id) return { ok: false, error: "each node needs an id" };
    if (ids.has(node.id)) return { ok: false, error: `duplicate node id '${node.id}'` };
    ids.add(node.id);
    if (typeof node.type !== "string" || !NODE_TYPES.has(node.type)) {
      return { ok: false, error: `node '${node.id}' has unknown type` };
    }
  }
  for (const n of nodes) {
    const node = n as Record<string, unknown>;
    for (const key of ["next", "nextTrue", "nextFalse", "onError"] as const) {
      const target = node[key];
      if (target !== undefined && (typeof target !== "string" || !ids.has(target))) {
        return { ok: false, error: `node '${node.id}' points at unknown node` };
      }
    }
    if (node.type === "llm") {
      const config = (node.config ?? {}) as Record<string, unknown>;
      // Caught at save time rather than mid-run: a workflow that cannot pass
      // validation is cheaper than one that fails on the 400th execution.
      if (typeof config.prompt !== "string" || !config.prompt.trim()) {
        return { ok: false, error: `llm node '${node.id}' needs a non-empty prompt` };
      }
      const task = String(config.task ?? "summarize").toLowerCase();
      if (!["classify", "extract", "summarize", "transform"].includes(task)) {
        return { ok: false, error: `llm node '${node.id}' has unknown task '${task}'` };
      }
      if (task === "classify") {
        const labels = Array.isArray(config.labels) ? config.labels.filter((x) => typeof x === "string" && x.trim()) : [];
        if (labels.length < 2) {
          return { ok: false, error: `llm node '${node.id}' classifies, so it needs at least two labels` };
        }
      }
      if (task === "extract") {
        const fields = Array.isArray(config.fields) ? config.fields.filter((x) => typeof x === "string" && x.trim()) : [];
        if (fields.length === 0) {
          return { ok: false, error: `llm node '${node.id}' extracts, so it needs a non-empty fields[]` };
        }
      }
    }
    if (node.type === "loop") {
      const config = (node.config ?? {}) as Record<string, unknown>;
      const targets = typeof config.do === "string" ? [config.do] : Array.isArray(config.do) ? config.do : [];
      for (const t of targets) {
        if (typeof t !== "string" || !ids.has(t)) {
          return { ok: false, error: `loop '${node.id}' names an unknown do-node` };
        }
      }
    }
  }
  return { ok: true, nodes: nodes as FlowNode[] };
}
