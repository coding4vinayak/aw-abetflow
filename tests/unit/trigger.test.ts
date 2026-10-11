// A webhook trigger used to be created with no secret and then answer anyone who
// found the path — the path is printed on the workflow page, so "found" is not
// hard. The rule now lives in parseTrigger: a webhook trigger needs a secret, or
// it has to say out loud that it is public.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTrigger } from "../../src/lib/definition";

describe("parseTrigger — webhook secrets", () => {
  it("refuses a webhook trigger with no secret", () => {
    const r = parseTrigger({ kind: "webhook", path: "inbound-form" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /needs a secret/);
  });

  it("refuses a secret that is not a string", () => {
    assert.equal(parseTrigger({ kind: "webhook", path: "p", secret: 42 }).ok, false);
    assert.equal(parseTrigger({ kind: "webhook", path: "p", secret: "" }).ok, false);
  });

  it("refuses a short secret rather than storing something guessable", () => {
    const r = parseTrigger({ kind: "webhook", path: "p", secret: "abc" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /at least 8/);
  });

  it("accepts a webhook trigger with a real secret", () => {
    const r = parseTrigger({ kind: "webhook", path: "orders", secret: "0123456789abcdef" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.trigger.path, "orders");
      assert.equal(r.trigger.secret, "0123456789abcdef");
      assert.equal(r.trigger.public, undefined);
    }
  });

  it("accepts an explicitly public trigger, and only on true", () => {
    assert.equal(parseTrigger({ kind: "webhook", path: "p", public: true }).ok, true);
    assert.equal(parseTrigger({ kind: "webhook", path: "p", public: "yes" }).ok, false);
    assert.equal(parseTrigger({ kind: "webhook", path: "p", public: false }).ok, false);
  });

  it("still rejects the shapes it always rejected", () => {
    assert.equal(parseTrigger({ kind: "webhook" }).ok, false);
    assert.equal(parseTrigger({ kind: "webhook", path: "../secrets" }).ok, false);
    assert.equal(parseTrigger({ kind: "telepathy" }).ok, false);
    assert.equal(parseTrigger(null).ok, false);
  });

  it("leaves manual and cron triggers alone", () => {
    assert.equal(parseTrigger({ kind: "manual" }).ok, true);
    assert.equal(parseTrigger({ kind: "cron", cron: "0 * * * *" }).ok, true);
    assert.equal(parseTrigger({ kind: "cron", cron: "not a cron" }).ok, false);
  });
});
