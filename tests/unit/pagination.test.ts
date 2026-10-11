// N1: /api/workflows and /api/executions both read page/limit straight from the
// query string, so page=0 was a negative skip and page=abc was NaN — two 500s
// for a mistyped URL — and limit=999999999 returned the tenant's whole table.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pageParams } from "../../src/lib/pagination";

const params = (query: Record<string, string>) => new URLSearchParams(query);

describe("page and limit are bounded by the server", () => {
  it("defaults to the first page at the route's own page size", () => {
    assert.deepEqual(pageParams(new URLSearchParams(""), 20), { page: 1, limit: 20 });
  });

  it("honours a sane page and limit", () => {
    assert.deepEqual(pageParams(params({ page: "4", limit: "5" }), 20), { page: 4, limit: 5 });
  });

  it("refuses to ask for the whole table", () => {
    assert.equal(pageParams(params({ limit: "999999999" }), 20).limit, 100);
  });

  it("treats a zero or negative page as the first page, not as a negative skip", () => {
    for (const page of ["0", "-4"]) assert.equal(pageParams(params({ page }), 20).page, 1, page);
  });

  it("treats a non-numeric or zero limit as the default, never as NaN or take:0", () => {
    for (const limit of ["abc", "", "0", "-1", "  "]) {
      assert.equal(pageParams(params({ limit }), 20).limit, 20, JSON.stringify(limit));
    }
  });

  it("keeps the offset arithmetic in the safe direction", () => {
    // parseInt stops at "e", so "1e9" reads as 1 rather than NaN. Pinning it
    // says which way the parser degrades: a small page, not a crash.
    assert.equal(pageParams(params({ limit: "1e9" }), 20).limit, 1);
    const { page, limit } = pageParams(params({ page: "2", limit: "20" }), 20);
    assert.equal((page - 1) * limit, 20);
  });
});
