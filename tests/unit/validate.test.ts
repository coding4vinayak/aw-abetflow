// N5: a wrong-typed field used to be the database's problem, and abetflow's
// database answered in a third way again — a *500* for a value Prisma could not
// put in a column, and a clean *insert* for a value the column only pretended to
// constrain. Measured over HTTP against a dev server whose `DATABASE_URL` pointed
// at a copy of `prisma/dev.db`, one wrong field per request (the full 75-case
// table is in the header of `src/lib/validate.ts`):
//
//   POST  /api/workflows              name: 42         500 PrismaClientValidationError
//   POST  /api/workflows              name: "   "      201, name "   " stored
//   POST  /api/workflows              status: "BOGUS"  201, stored — SQLite has no enum
//   POST  /api/workflows              status: ""       201, stored DRAFT ("not mentioned")
//   POST  /api/workflows              body "prose"     500 — request.json() throws
//   PATCH /api/workflows/:id          {}               200, and a numbered WorkflowVersion
//   PATCH /api/workflows/:id          note: 42         200, note dropped, snapshot written
//   POST  /api/workflows/:id/versions version: 1.5     200 — rolled back to v1
//   POST  /api/variables              name: ["ok"]     500, after the regex said it was valid
//   POST  /api/executions             sync: "yes"      202, queued instead of run inline
//   POST  /api/try-node               text: 42         400 "Paste some text to work on."
//   POST  /api/try-node               task: 42         200 — accepted; the node it would
//                                                      have run is `readTask`'s fallback
//
// These pin the engine's contract, because every write route here is written
// against it. Each row was replayed through the running app with the tables wired
// (after-probe: same cases, `n5-af-after.txt`). What pins the routes against
// someone forgetting the next one is `route-validation.test.ts`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boolFlag,
  NO_FIELD_TO_UPDATE,
  readJson,
  validateBody,
  type Schema,
} from "../../src/lib/validate";
import {
  CREDENTIAL_PUT,
  EXECUTION_CREATE,
  LLM_TRY_NODE,
  VARIABLE_PUT,
  WORKFLOW_CREATE,
  WORKFLOW_PATCH,
  WORKFLOW_ROLLBACK,
} from "../../src/lib/fields";

const body = async (response: Response) =>
  (await response.json()) as { error: string; fields?: Record<string, string> };

/** An otherwise-valid create, so a test can send exactly one wrong field. */
const GOOD = { name: "nightly sync", definition: { nodes: [{ id: "t1", type: "trigger", config: {}, next: "n1" }] } };

const ONE = {
  name: { kind: "text", required: true, max: 20 },
  nickname: { kind: "text", nullable: true },
} satisfies Schema;

describe("a field the route did not declare is not a value it will write", () => {
  it("omits a key the body never mentioned, so PATCH cannot reset it", () => {
    const result = validateBody({ name: "kept" }, ONE);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.data ?? {}), ["name"]);
    assert.equal("nickname" in (result.data ?? {}), false);
  });

  it("never lets a caller write a column the table does not name", () => {
    // `workspaceId` comes from the key and `id` from the path. Both used to be
    // readable out of the body by the PATCH — `authedWorkspaceId` refuses a claim
    // that is not the key's own workspace, but the shape it was handed was whatever
    // the caller sent.
    const ok = validateBody({ ...GOOD, workspaceId: "other", id: "mine" }, WORKFLOW_CREATE);
    assert.equal(ok.ok, true);
    assert.equal("workspaceId" in (ok.data ?? {}), false);
    assert.equal("id" in (ok.data ?? {}), false);
  });

  it("names every field that is wrong, in one response", async () => {
    const result = validateBody({ name: 42, nickname: [] }, ONE);
    assert.equal(result.ok, false);
    const payload = await body(result.error!);
    assert.match(payload.error, /name must be text/);
    assert.match(payload.error, /nickname must be text/);
    assert.deepEqual(Object.keys(payload.fields ?? {}).sort(), ["name", "nickname"]);
  });
});

describe("the request body itself", () => {
  const request = (payload: string | undefined) =>
    new Request("http://localhost/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

  it("is a 400 when it is not JSON, where `request.json()` was a 500", async () => {
    // Measured on six of the eight body-reading routes: the throw happened inside
    // the handler, which `withAuth` does not map.
    for (const payload of ["", "not json", "{", '{"name": "Ada",}']) {
      const parsed = await readJson(request(payload));
      assert.equal(parsed.ok, false, JSON.stringify(payload));
      assert.equal(parsed.error?.status, 400);
      assert.equal((await body(parsed.error!)).error, "request body is not valid JSON");
    }
  });

  it("is a 400 when it is JSON but not an object", async () => {
    // Valid JSON that is not a JSON *object* reached `body.workspaceId` in the
    // handler's next line, which throws on `null` and yields `undefined` on a
    // number — the same 500 by a different road. The check is here so the handlers
    // can authenticate before they validate.
    for (const payload of ["null", "42", '"prose"', "[1,2]"]) {
      const parsed = await readJson(request(payload));
      assert.equal(parsed.ok, false, payload);
      assert.match((await body(parsed.error!)).error, /^request body must be a JSON object, got /);
    }
  });

  it("hands the route an object it can index", async () => {
    const parsed = await readJson(request('{"name":"Ada"}'));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.body, { name: "Ada" });
  });
});

describe("text", () => {
  it("trims, because a padded name is a row no one finds by name", () => {
    const result = validateBody({ ...GOOD, name: "  nightly sync  " }, WORKFLOW_CREATE);
    assert.equal(result.ok && result.data.name, "nightly sync");
  });

  it("refuses blank for a NOT NULL column and clears it for a nullable one", async () => {
    // `name: "   "` was a 201 with the spaces stored. `name: ""` was a 400 already,
    // because `if (!name)` — the same rule now says it for every blank text field.
    assert.equal((await body(validateBody({ ...GOOD, name: "   " }, WORKFLOW_CREATE).error!)).error, "name must be a non-empty string");
    const cleared = validateBody({ name: "x", nickname: "  " }, ONE);
    assert.equal(cleared.ok && cleared.data.nickname, null);
  });

  it("says how long it was", async () => {
    // `name` is 100 in the variables table and 200 in workflows — the cap is the
    // column's, and both were unenforced: measured, a 5000-character variable name
    // and a 4000-character credential name were 201s.
    const result = validateBody({ name: "n".repeat(101), value: "v" }, VARIABLE_PUT);
    assert.match((await body(result.error!)).error, /name is 101 characters; at most 100/);
    const cred = validateBody({ name: "c".repeat(101), provider: "http", value: "v" }, CREDENTIAL_PUT);
    assert.match((await body(cred.error!)).error, /name is 101 characters; at most 100/);
  });

  it("refuses a non-string rather than running String() on it", async () => {
    // The name regex `/^[a-zA-Z_][a-zA-Z0-9_]*$/` is applied to `String(name)` by
    // `.test()` itself: `["ok"]` was therefore a valid identifier as far as the
    // check went, and a 500 by the time Prisma saw it. `{}` was told its name was
    // "the wrong shape" — right refusal, wrong reason.
    assert.equal(validateBody({ name: ["ok"], value: "v" }, VARIABLE_PUT).ok, false);
    assert.match(
      (await body(validateBody({ name: ["ok"], value: "v" }, VARIABLE_PUT).error!)).error,
      /name must be text, got an array/,
    );
    // The article is part of the answer a client reads. `typeof` says "object" for
    // an object, and `a ${typeof}` made the message "got a object" — which reads
    // like a typo in the caller's own code and sends them looking in the wrong place.
    assert.match(
      (await body(validateBody({ name: {}, value: "v" }, VARIABLE_PUT).error!)).error,
      /name must be text, got an object/,
    );
    assert.match(
      (await body(validateBody({ name: "x", value: 42 }, CREDENTIAL_PUT).error!)).error,
      /value must be text, got a number/,
    );
  });
});

describe("the integer a rollback version has to be", () => {
  it("refuses a fraction the comparison would have accepted", async () => {
    // Measured: `version: 1.5` passed the route's `typeof version !== "number"`
    // check and answered 200. SQLite matched 1.5 against the stored integer 1 in
    // the composite unique key, so the workflow rolled back to v1 while the new
    // snapshot's own note read "Rollback to v1.5" — a rollback to a version that
    // never existed, described by a number no reader can ask for again.
    assert.equal(validateBody({ version: 1.5 }, WORKFLOW_ROLLBACK).ok, false);
    assert.match(
      (await body(validateBody({ version: 1.5 }, WORKFLOW_ROLLBACK).error!)).error,
      /version must be a whole number, got a number/,
    );
    assert.equal(validateBody({ version: 2 }, WORKFLOW_ROLLBACK).ok, true);
  });

  it("refuses a quoted number and says how to send it", async () => {
    assert.match(
      (await body(validateBody({ version: "2" }, WORKFLOW_ROLLBACK).error!)).error,
      /version must be a whole number, got "2" as text — send it unquoted/,
    );
  });

  it("refuses a version below the first, which used to be a 404", async () => {
    // `version: -3` was 404 "Version not found" — true, but the caller had sent a
    // number no workflow can ever have had, and 404 says nothing about the field.
    assert.match(
      (await body(validateBody({ version: -3 }, WORKFLOW_ROLLBACK).error!)).error,
      /version must be at least 1/,
    );
  });
});

describe("the enum a SQLite column cannot enforce", () => {
  it("refuses a value outside the set and lists the set", async () => {
    // `Workflow.status` is a plain String whose legal words live in a schema
    // comment. "BOGUS" was an insert: the workflow appeared in every list, and no
    // `status !== "ACTIVE"` guard let it run.
    const result = validateBody({ ...GOOD, status: "BOGUS" }, WORKFLOW_CREATE);
    assert.match(
      (await body(result.error!)).error,
      /status must be one of DRAFT \| ACTIVE \| PAUSED \| ARCHIVED, got "BOGUS"/,
    );
  });

  it("does not fold case, because the code compares with ===", () => {
    // Measured: `status: "archived"` was a 201 with lowercase stored, so
    // `where: { status: "ARCHIVED" }` found nothing and `!== "ACTIVE"` refused to run.
    assert.equal(validateBody({ status: "archived" }, WORKFLOW_PATCH).ok, false);
    assert.equal(validateBody({ status: "ARCHIVED" }, WORKFLOW_PATCH).ok, true);
  });

  it("refuses a non-string value the falsiness test read as absent", () => {
    // `...(status ? { status } : {})` made `status: ""` mean "not mentioned" and
    // `status: 42` mean "write 42". One of those is a reasonable accident; both
    // were silent.
    assert.equal(validateBody({ status: "" }, WORKFLOW_PATCH).ok, false);
    assert.equal(validateBody({ status: 42 }, WORKFLOW_PATCH).ok, false);
    assert.equal("status" in (validateBody({ name: "x" }, WORKFLOW_PATCH).data ?? {}), false);
  });

  it("applies to the playground's task as well as to a column", async () => {
    // `task: 42` reached `readTask`, which falls back to "summarize" — so a caller
    // trying a classify node would have been shown a summary of their text, with
    // nothing said about the mistake. [code: llm-node.ts; the probe 200'd with
    // {configured:false} because that server had no LLM key]
    assert.match(
      (await body(validateBody({ text: "hello", task: 42 }, LLM_TRY_NODE).error!)).error,
      /task must be one of classify \| extract \| summarize \| transform, got a number/,
    );
  });
});

describe("JSON columns", () => {
  it("refuses the scalar a Json column takes without complaint", () => {
    // `definition: 42` was a 500 on the way into Prisma, and `input: 42` /
    // `"prose"` / `[1,2]` were all 202s — stored as the run's payload, which a
    // template like `{{input.name}}` then resolved to nothing.
    assert.equal(validateBody({ ...GOOD, definition: 42 }, WORKFLOW_CREATE).ok, false);
    assert.equal(validateBody({ workflowId: "w1", input: 42 }, EXECUTION_CREATE).ok, false);
    assert.equal(validateBody({ workflowId: "w1", input: { a: 1 } }, EXECUTION_CREATE).ok, true);
    assert.equal(validateBody({ workflowId: "w1", input: [1, 2] }, EXECUTION_CREATE).ok, true);
  });

  it("refuses null and says what to send instead", async () => {
    // Prisma writes a NULL into a Json column with its own DbNull sentinel, so a
    // caller's null has no honest translation at this boundary.
    const result = validateBody({ ...GOOD, trigger: null }, WORKFLOW_CREATE);
    assert.match((await body(result.error!)).error, /send \{\} to clear it/);
  });

  it("refuses a scalar body where an object was asked for", async () => {
    const result = validateBody("prose", WORKFLOW_CREATE);
    assert.match((await body(result.error!)).error, /request body must be a JSON object, got a string/);
  });

  it("caps what one request can store", async () => {
    const result = validateBody(
      { graph: { blob: "x".repeat(2048) } },
      { graph: { kind: "json", max: 100 } } satisfies Schema,
    );
    assert.match((await body(result.error!)).error, /bytes of JSON; at most 100/);
  });
});

describe("an array of strings, which the llm node's labels and fields are", () => {
  it("refuses the scalar a later reader finds nothing in", async () => {
    // `labels: "a,b"` was accepted at the boundary and handed to `runLlmNode` as
    // a string, whose `readStringList` returns `[]` for a non-array — so a classify
    // node runs with *no labels at all* and throws about needing two, three layers
    // away from the caller's typo. That last part is read from `llm-node.ts`
    // [code]; the probe server had no LLM key, so the request never got that far.
    assert.equal(validateBody({ text: "x", labels: "a,b" }, LLM_TRY_NODE).ok, false);
    assert.match(
      (await body(validateBody({ text: "x", labels: "a,b" }, LLM_TRY_NODE).error!)).error,
      /labels must be an array of strings/,
    );
    assert.match(
      (await body(validateBody({ text: "x", fields: [42] }, LLM_TRY_NODE).error!)).error,
      /fields\[0\] must be text, got a number/,
    );
  });

  it("treats absent as nothing sent, not as empty", () => {
    // The playground's own defaults only apply when the caller did not name a
    // list; an empty one is a caller who means "no labels", which the node refuses.
    assert.equal("labels" in (validateBody({ text: "x" }, LLM_TRY_NODE).data ?? {}), false);
    assert.deepEqual(validateBody({ text: "x", labels: [] }, LLM_TRY_NODE).data?.labels, []);
  });

  it("deduplicates and trims, so [t, t] is one entry", () => {
    assert.deepEqual(
      validateBody({ text: "x", labels: [" bug ", "billing", "bug"] }, LLM_TRY_NODE).data?.labels,
      ["bug", "billing"],
    );
  });

  it("caps the list", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `l${i}`);
    assert.match(
      (await body(validateBody({ text: "x", labels: many }, LLM_TRY_NODE).error!)).error,
      /labels holds 51 entries; at most 50/,
    );
  });
});

describe("null", () => {
  it("clears a nullable column and is refused on one that is not", () => {
    assert.equal(validateBody({ name: "x", nickname: null }, ONE).data?.nickname, null);
    const result = validateBody({ name: "x", nickname: null }, { name: { kind: "text" }, nickname: { kind: "text" } } satisfies Schema);
    assert.equal(result.ok, false);
  });

  it("is not the same as leaving a field out", () => {
    const absent = validateBody({ name: "x" }, ONE);
    assert.equal(absent.ok && "nickname" in absent.data, false);
    const sent = validateBody({ name: "x", nickname: null }, ONE);
    assert.equal(sent.ok && "nickname" in sent.data, true);
  });

  it("clears a nullable column, and a required field cannot be cleared", () => {
    assert.equal(validateBody({ name: "kept", description: null }, WORKFLOW_PATCH).data?.description, null);
    assert.equal(validateBody({ name: null, definition: { nodes: [] } }, WORKFLOW_CREATE).ok, false);
  });
});

describe("PATCH", () => {
  it("refuses a body that asks to change nothing", async () => {
    assert.equal(validateBody({}, WORKFLOW_PATCH, { requireWrite: true }).ok, false);
    assert.equal(validateBody({ foo: 1 }, WORKFLOW_PATCH, { requireWrite: true }).ok, false);
    assert.match(
      (await body(validateBody({ foo: 1 }, WORKFLOW_PATCH, { requireWrite: true }).error!)).error,
      new RegExp(NO_FIELD_TO_UPDATE),
    );
    assert.equal(validateBody({ description: null }, WORKFLOW_PATCH, { requireWrite: true }).ok, true);
  });

  it("counts a note-only body as a write, which is why the route checks it again", () => {
    // The engine can only see the fields it was given, and every one of them is
    // optional in a PATCH table. `note` writes `WorkflowVersion`, not the workflow,
    // so "did this request change the workflow?" is a question only the handler can
    // answer — measured, `PATCH {}` and `PATCH {note: 42}` were each a 200 that
    // created a numbered snapshot anyway. `route.ts` refuses both with its own
    // `changesWorkflow` check, using the same wording as this constant.
    assert.equal(validateBody({ note: "before I edit" }, WORKFLOW_PATCH, { requireWrite: true }).ok, true);
  });

  it("reports a missing required field ahead of the empty-update rule", async () => {
    const result = validateBody({ foo: 1 }, { status: { kind: "enum", required: true, values: ["ACTIVE"] } }, { requireWrite: true });
    assert.match((await body(result.error!)).error, /status is required/);
  });
});

describe("a route-control flag that is not a column", () => {
  it("refuses a truthy value the route was going to ignore", () => {
    // `sync: "yes"` was a 202 with a QUEUED row: the caller asked for the run
    // inline and got a run nobody had started, with nothing in the answer to say
    // so. `sync === true` is the only thing the route has ever honoured.
    assert.equal(boolFlag(undefined, "sync").value, undefined);
    assert.equal(boolFlag(null, "sync").value, undefined);
    assert.equal(boolFlag(true, "sync").value, true);
    assert.equal(boolFlag(false, "sync").value, false);
    assert.equal(boolFlag("yes", "sync").ok, false);
    assert.equal(boolFlag(1, "sync").ok, false);
  });

  it("says how to send it", async () => {
    const result = boolFlag("true", "sync");
    assert.match((await body(result.error!)).error, /sync must be true or false, got a string — send it unquoted/);
    assert.equal(result.error?.status, 400);
  });
});
