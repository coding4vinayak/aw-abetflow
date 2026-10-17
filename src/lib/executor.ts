import jsonata from "jsonata";
import { assertAllowedTarget } from "./egress";
import { runLlmNode, type LlmCompleteFn } from "./llm-node";

export type NodeType =
  | "trigger"
  | "http_request"
  | "transform"
  | "condition"
  | "set_variable"
  | "delay"
  | "loop"
  | "merge"
  | "note" | "llm";

export interface FlowNode {
  id: string;
  type: NodeType;
  config?: Record<string, unknown>;
  /** Next node on the happy path. */
  next?: string;
  /** Condition branches. */
  nextTrue?: string;
  nextFalse?: string;
  /** Where to go when this node throws and continues. */
  onError?: string;
  /** Record the failure and keep walking instead of failing the run. */
  continueOnFail?: boolean;
}

export interface WorkflowDef {
  nodes: FlowNode[];
}

export interface StepLog {
  nodeId: string;
  nodeType: string;
  status: "OK" | "FAILED" | "SKIPPED";
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ExecContext {
  vars: Record<string, unknown>;
  credentials: Record<string, Record<string, string>>;
  httpFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Injection seam for the llm node; defaults to the configured provider. */
  llmComplete?: LlmCompleteFn;
}

export interface ExecResult {
  status: "COMPLETED" | "FAILED";
  output: unknown;
  steps: StepLog[];
  vars: Record<string, unknown>;
  error?: string;
}

const MAX_STEPS = 200;
const MAX_LOOP_ITEMS = 100;
const MAX_DELAY_SECONDS = 300;
const HTTP_TIMEOUT_MS = 10000;
const HTTP_MAX_CHARS = 8000;

function getPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((obj, key) => {
    if (obj !== null && typeof obj === "object" && key in obj) {
      return (obj as Record<string, unknown>)[key];
    }
    return undefined;
  }, root);
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * {{input.a.b}} / {{vars.name}} interpolation. Unknown paths render empty —
 * a silent empty string beats a leaked placeholder reaching a customer.
 */
export function renderTemplate(template: string, input: unknown, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, expr: string) => {
    const path = expr.trim();
    if (path.startsWith("input.")) return str(getPath(input, path.slice(6)));
    if (path.startsWith("vars.")) return str(getPath(vars, path.slice(5)));
    return "";
  });
}

function renderDeep(value: unknown, input: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") return renderTemplate(value, input, vars);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, input, vars));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, input, vars)]));
  }
  return value;
}

interface EvalScope {
  input: unknown;
  vars: Record<string, unknown>;
}

async function evalJsonata(expression: unknown, scope: EvalScope): Promise<unknown> {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("transform/condition needs a JSONata expression");
  }
  // Bindings make `$vars.x` work alongside `vars.x` — the engine accepts
  // both spellings rather than failing mysterious evaluations.
  return await jsonata(expression).evaluate(scope, { input: scope.input, vars: scope.vars });
}

/**
 * JSONata's own boolean rule, asked of JSONata itself.
 *
 * `verdict ? nextTrue : nextFalse` is JavaScript truthiness, and it disagrees
 * with JSONata exactly where empty flows hurt: `[]` and `{}` are false to
 * JSONata but truthy to JS, so a condition on `input.items` took nextTrue
 * when the list was empty (`[0]` is false to JSONata too, true to JS). Asking
 * `$boolean($)` keeps the branch the documented "JSONata truth test" —
 * including its corners — instead of re-deriving the rules here.
 */
export async function jsonataTruth(value: unknown): Promise<boolean> {
  return (await jsonata("$boolean($)").evaluate(value)) === true;
}

/**
 * The stored body of an http_request, capped at the README's 8KB for every
 * content type.
 *
 * This used to slice the text but then `JSON.parse` the *whole* response, so
 * a 5MB JSON document was stored whole in the step log while the cap was
 * documented as a general one. Slice first, then try to parse the slice: a
 * JSON document larger than the cap arrives as its text prefix — a truncated
 * document must not masquerade as parsed data.
 */
export function cappedBody(text: string): unknown {
  const capped = text.slice(0, HTTP_MAX_CHARS);
  try {
    return JSON.parse(capped);
  } catch {
    return capped;
  }
}

async function httpCall(
  node: FlowNode,
  input: unknown,
  vars: Record<string, unknown>,
  fetchFn: ExecContext["httpFetch"],
): Promise<unknown> {
  const config = node.config ?? {};
  const url = renderTemplate(str(config.url ?? ""), input, vars);
  if (!/^https?:\/\//i.test(url)) throw new Error(`http_request needs an http(s) URL, got '${url.slice(0, 80)}'`);
  // Checked here rather than at the write boundary: `renderTemplate` above can
  // assemble the address out of run input, so the stored definition is not what gets
  // connected to — and #74/#75 say a public trigger can supply that input.
  await assertAllowedTarget(url, "url");
  const method = String(config.method ?? "GET").toUpperCase();
  const headers = (config.headers ?? {}) as Record<string, string>;
  const doFetch = fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method,
      headers,
      signal: ctrl.signal,
      ...(config.body !== undefined ? { body: JSON.stringify(renderDeep(config.body, input, vars)) } : {}),
    });
    const text = await res.text();
    const body = cappedBody(text);
    const out = { status: res.status, body };
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { response: out });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the graph from the trigger node to a terminal output.
 *
 * Deterministic given the same definition, input and vars — which is what
 * makes every execution replayable from its step log. Cycles cannot hang a
 * worker: the step budget stops them and names the node it stopped at.
 */
export async function executeGraph(def: WorkflowDef, input: unknown, ctx: ExecContext): Promise<ExecResult> {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const start = def.nodes.find((n) => n.type === "trigger") ?? def.nodes[0];
  if (!start) return { status: "COMPLETED", output: input, steps: [], vars: ctx.vars };

  const steps: StepLog[] = [];
  const vars = ctx.vars;
  let loopOutputs: unknown[] = [];
  let current: FlowNode | undefined = start;
  let lastOutput: unknown = input;

  while (current && steps.length < MAX_STEPS) {
    const node: FlowNode = current;
    const began = Date.now();
    try {
      switch (node.type) {
        case "trigger": {
          lastOutput = input;
          steps.push({ nodeId: node.id, nodeType: node.type, status: "OK", output: lastOutput, durationMs: Date.now() - began });
          current = node.next ? byId.get(node.next) : undefined;
          break;
        }
        case "note": {
          const text = renderTemplate(str(node.config?.text ?? ""), lastOutput, vars);
          lastOutput = text;
          steps.push({ nodeId: node.id, nodeType: node.type, status: "OK", output: text, durationMs: Date.now() - began });
          current = node.next ? byId.get(node.next) : undefined;
          break;
        }
        case "set_variable": {
          const name = str(node.config?.name ?? "");
          if (!name) throw new Error("set_variable needs a name");
          const value = renderDeep(node.config?.value, lastOutput, vars);
          vars[name] = value;
          // When the flow carries an object, the variable joins it — so
          // downstream `input.*` expressions keep working after this node.
          // For scalar flows the value itself becomes the output.
          lastOutput =
            lastOutput !== null && typeof lastOutput === "object" && !Array.isArray(lastOutput)
              ? { ...(lastOutput as Record<string, unknown>), [name]: value }
              : value;
          steps.push({ nodeId: node.id, nodeType: node.type, status: "OK", output: lastOutput, durationMs: Date.now() - began });
          current = node.next ? byId.get(node.next) : undefined;
          break;
        }
        case "transform": {
          const out = await evalJsonata(node.config?.expression, { input: lastOutput, vars });
          lastOutput = out;
          steps.push({ nodeId: node.id, nodeType: node.type, status: "OK", output: out, durationMs: Date.now() - began });
          current = node.next ? byId.get(node.next) : undefined;
          break;
        }
        case "condition": {
          const verdict = await evalJsonata(node.config?.expression, { input: lastOutput, vars });
          // JSONata truth, not JS truth: [] and {} are false to the expression
          // language the README calls a "JSONata truth test" — and JS calls
          // both true, so the empty case used to take nextTrue.
          const result = await jsonataTruth(verdict);
          const branch = result ? node.nextTrue : node.nextFalse;
          steps.push({ nodeId: node.id, nodeType: node.type, status: "OK", output: { result }, durationMs: Date.now() - began });
          current = branch ? byId.get(branch) : undefined;
          break;
        }
        case "http_request": {
          const out = await httpCall(node, lastOutput, vars, ctx.httpFetch);
          lastOutput = out;
          steps.push({ nodeId: node.id, nodeType: node.type, status: "OK", output: out, durationMs: Date.now() - began });
          current = node.next ? byId.get(node.next) : undefined;
          break;
        }
        case "delay": {
          const seconds = Math.min(Math.max(Number(node.config?.seconds ?? 0) || 0, 0), MAX_DELAY_SECONDS);
          if (seconds > 0) await new Promise((r) => setTimeout(r, seconds * 1000));
          steps.push({ nodeId: node.id, nodeType: node.type, status: "OK", output: { waitedSeconds: seconds }, durationMs: Date.now() - began });
          current = node.next ? byId.get(node.next) : undefined;
          break;
        }
        case "loop": {
          const evaluated = await evalJsonata(node.config?.items, { input: lastOutput, vars });
          // JSONata collapses a one-element sequence to the value itself, so
          // "a list with one match" arrives here as that bare value — running
          // zero iterations for it was the silent version of this bug. Only
          // "no value at all" is no items.
          const all =
            Array.isArray(evaluated) ? evaluated : evaluated === null || evaluated === undefined ? [] : [evaluated];
          const list = all.slice(0, MAX_LOOP_ITEMS);
          const rawDo: unknown = node.config?.do;
          const doIds: string[] = typeof rawDo === "string" ? [rawDo] : Array.isArray(rawDo) ? rawDo.filter((d: unknown): d is string => typeof d === "string") : [];
          const body = doIds.map((id: string) => byId.get(id)).filter((n: FlowNode | undefined): n is FlowNode => Boolean(n));
          if (body.length === 0) throw new Error("loop needs a 'do' node id (or list of ids)");
          const collected: unknown[] = [];
          for (const item of list) {
            const sub = await executeGraph({ nodes: body }, item, {
              vars,
              credentials: ctx.credentials,
              httpFetch: ctx.httpFetch,
            });
            if (sub.status === "FAILED") throw new Error(`loop item failed: ${sub.error}`);
            collected.push(sub.output);
            for (const s of sub.steps) {
              steps.push(s);
              if (steps.length >= MAX_STEPS) break;
            }
          }
          // Loops pool their outputs until a merge flushes them: a second
          // loop before the merge used to replace the first loop's items and
          // silently drop half the data.
          loopOutputs = [...loopOutputs, ...collected];
          lastOutput = collected;
          steps.push({
            nodeId: node.id,
            nodeType: node.type,
            status: "OK",
            output: { items: collected.length, ...(all.length > list.length ? { evaluated: all.length } : {}) },
            durationMs: Date.now() - began,
          });
          current = node.next ? byId.get(node.next) : undefined;
          break;
        }
        case "llm": {
          const out = await runLlmNode({
            prompt: renderTemplate(String(node.config?.prompt ?? ""), lastOutput, vars),
            input: lastOutput,
            config: (node.config ?? {}) as Record<string, unknown>,
            llmComplete: ctx.llmComplete,
          });
          lastOutput = out;
          steps.push({ nodeId: node.id, nodeType: node.type, status: "OK", output: out, durationMs: Date.now() - began });
          current = node.next ? byId.get(node.next) : undefined;
          break;
        }
        case "merge": {
          lastOutput = [...loopOutputs];
          loopOutputs = [];
          steps.push({ nodeId: node.id, nodeType: node.type, status: "OK", output: lastOutput, durationMs: Date.now() - began });
          current = node.next ? byId.get(node.next) : undefined;
          break;
        }
        default: {
          throw new Error(`Unknown node type '${(node as { type: string }).type}'`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      steps.push({ nodeId: node.id, nodeType: node.type, status: "FAILED", error: message, durationMs: Date.now() - began });
      if (node.continueOnFail) {
        lastOutput = { error: message };
        current = node.onError ? byId.get(node.onError) : node.next ? byId.get(node.next) : undefined;
        continue;
      }
      return { status: "FAILED", output: lastOutput, steps, vars, error: `${node.id}: ${message}` };
    }
  }

  if (current && steps.length >= MAX_STEPS) {
    return { status: "FAILED", output: lastOutput, steps, vars, error: `Step budget exhausted at '${current.id}' — possible cycle` };
  }
  return { status: "COMPLETED", output: lastOutput, steps, vars };
}
