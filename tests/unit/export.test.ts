// The export surface, pinned without a database.
//
// The route scanner proves the handlers authenticate. This file owns the parts
// a request would not make obvious: the filename cannot carry a header, a
// credential row loses its ciphertext/iv, a webhook row loses its secret, the
// execution audit keeps its ordered trace, user text cannot become a
// spreadsheet formula, and the JSON builder does not quietly select a
// credential column.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  executionCsvHeader,
  executionCsvRow,
  exportDownloadHeaders,
  exportFilename,
  publicWebhook,
} from "../../src/lib/export";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Minimal RFC 4180 reader for one encoded line; CRLF inside a cell is not in these fixtures. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

describe("export filenames", () => {
  it("sanitises a slug before it reaches Content-Disposition", () => {
    const name = exportFilename('Acme "EU"/Ops\r\n', "workspace", new Date("2026-10-20T12:00:00Z"));
    assert.equal(name, "abetflow-acme-eu-ops-workspace-2026-10-20.json");
    assert.equal(
      exportFilename("", "executions", new Date("2026-10-20T12:00:00Z")),
      "abetflow-workspace-executions-2026-10-20.csv",
    );
  });

  it("marks every download no-store and nosniff", () => {
    const headers = exportDownloadHeaders("abetflow-acme-executions-2026-10-20.csv", "text/csv; charset=utf-8");
    assert.equal(headers["content-disposition"], 'attachment; filename="abetflow-acme-executions-2026-10-20.csv"');
    assert.equal(headers["cache-control"], "no-store");
    assert.equal(headers["x-content-type-options"], "nosniff");
  });
});

describe("the public webhook projection", () => {
  it("returns the webhook row as-is (secret is never selected)", () => {
    const hook = { id: "w_1", url: "https://example.test/hook", events: "execution.completed", isActive: true, createdAt: new Date(), updatedAt: new Date() };
    const exported = publicWebhook(hook);
    assert.deepEqual(exported, { id: "w_1", url: "https://example.test/hook", events: "execution.completed", isActive: true, createdAt: hook.createdAt, updatedAt: hook.updatedAt });
  });
});

describe("the execution-audit CSV", () => {
  it("has a stable header and preserves the ordered step trace", () => {
    assert.equal(
      executionCsvHeader(),
      '"execution_id","workflow_id","workflow_name","status","source","input","output","error","created_at","started_at","completed_at","steps_json"\r\n',
    );

    const row = parseCsvLine(
      executionCsvRow({
        id: "ex_1",
        workflowId: "wf_1",
        workflowName: "Order Process",
        status: "COMPLETED",
        source: "webhook",
        input: { orderId: "123" },
        output: { result: "ok" },
        error: null,
        createdAt: new Date("2026-03-01T12:00:00Z"),
        startedAt: new Date("2026-03-01T12:00:01Z"),
        completedAt: new Date("2026-03-01T12:00:02Z"),
        steps: [
          { position: 1, nodeId: "n1", nodeType: "http", status: "OK", output: { status: 200 }, error: null, durationMs: 150, createdAt: "2026-03-01T12:00:01.100Z" },
          { position: 2, nodeId: "n2", nodeType: "transform", status: "OK", output: { mapped: true }, error: null, durationMs: 5, createdAt: "2026-03-01T12:00:01.500Z" },
        ],
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[0], "ex_1");
    assert.equal(row[1], "wf_1");
    assert.equal(row[2], "Order Process");
    assert.equal(row[3], "COMPLETED");
    assert.equal(row[4], "webhook");
    assert.equal(row[5], '{"orderId":"123"}');
    assert.equal(row[6], '{"result":"ok"}');
    assert.equal(row[7], "");
    assert.equal(row[8], "2026-03-01T12:00:00.000Z");
    assert.equal(row[9], "2026-03-01T12:00:01.000Z");
    assert.equal(row[10], "2026-03-01T12:00:02.000Z");
    assert.deepEqual(JSON.parse(row[11]), [
      { position: 1, nodeId: "n1", nodeType: "http", status: "OK", output: { status: 200 }, error: null, durationMs: 150, createdAt: "2026-03-01T12:00:01.100Z" },
      { position: 2, nodeId: "n2", nodeType: "transform", status: "OK", output: { mapped: true }, error: null, durationMs: 5, createdAt: "2026-03-01T12:00:01.500Z" },
    ]);
  });

  it("refuses to let execution input become a formula", () => {
    const row = parseCsvLine(
      executionCsvRow({
        id: "ex_2",
        workflowId: "wf_2",
        workflowName: "=HYPERLINK(\"https://example.test\")",
        status: "FAILED",
        source: "manual",
        input: "line one; line two",
        output: null,
        error: "step threw",
        createdAt: "2026-03-01T12:00:00.000Z",
        startedAt: null,
        completedAt: null,
        steps: [],
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[2], "'=HYPERLINK(\"https://example.test\")");
    assert.ok(row[5].includes("line one; line two"), `input column should contain the text, got: ${row[5]}`);
    assert.equal(row[7], "step threw");
    assert.equal(row[9], "");
    assert.equal(row[10], "");
    assert.deepEqual(JSON.parse(row[11]), []);
  });
});

describe("the export builder's boundaries", () => {
  const builder = source("../../src/lib/export.ts");

  it("selects content, never credential columns", () => {
    for (const forbidden of [
      "ciphertext: true",
      "iv: true",
      "secret: true",
      "tokenHash: true",
      "hashedKey: true",
      "passwordHash: true",
      "stripeCustomerId: true",
      "stripeSubscriptionId: true",
    ]) {
      assert.equal(builder.includes(forbidden), false, `${forbidden} must not be selected by an export`);
    }
  });

  it("scopes every collection query to the workspace", () => {
    const scoped = builder.match(/where:\s*\{\s*workspaceId/g) ?? [];
    assert.ok(scoped.length >= 7, `only ${scoped.length} workspace-scoped queries found — a query may be exporting another tenant's rows`);
  });

  it("keeps execution rows out of the in-memory document and points at the stream", () => {
    assert.ok(builder.includes('download: "/api/export/executions"'));
    assert.ok(builder.includes("executions: {"), "the document carries the count object");
    assert.equal(/executions:\s*\[/.test(builder), false, "execution rows must not be embedded as an array");
  });

  it("every export route authenticates, checks the role, and uses the shared headers", () => {
    for (const route of [
      "../../src/app/api/export/route.ts",
      "../../src/app/api/export/executions/route.ts",
    ]) {
      const src = source(route);
      assert.match(src, /getSession\(\)/, `${route} must resolve the browser session`);
      assert.match(src, /canManageRoles\(session\.role\)/, `${route} must refuse a member`);
      assert.match(src, /exportDownloadHeaders/, `${route} must use the no-store download headers`);
    }
  });
});