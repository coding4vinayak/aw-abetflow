// The changelog is the page a buyer — and an assistant — reads to see what is
// new.
//
// It drifted twice: the app gained the example workflow and the changelog did
// not mention it, and the entries were not in the order the page promises
// ("newest first" was printed above v1.0.0 and v1.1.0 in that order). So the
// shipped features are listed below, the order is checked, and both fail the
// build when they stop being true.
//
// **When you ship a public feature, add it here and write the changelog entry.**
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CHANGELOG = readFileSync(new URL("../../src/app/changelog/page.tsx", import.meta.url), "utf8");

const SHIPPED = [
  { feature: "the example workflow (the first run)", marks: ["example workflow"] },
  { feature: "the workspace export", marks: ["workspace JSON"] },
  { feature: "the execution audit", marks: ["streamed CSV"] },
];

describe("the changelog", () => {
  it("mentions every feature the app ships", () => {
    for (const { feature, marks } of SHIPPED) {
      for (const mark of marks) {
        assert.ok(CHANGELOG.includes(mark), `the changelog must mention ${feature} ("${mark}")`);
      }
    }
  });

  it("reads newest first, as the page promises", () => {
    // A v1.10 written below v1.9 is a lie about the order, and the order is
    // the whole point of the page.
    const versions = [...CHANGELOG.matchAll(/v(\d+)\.(\d+)\.(\d+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
    ]);
    assert.ok(versions.length >= 2, "the changelog should have entries");
    for (let i = 1; i < versions.length; i++) {
      const [a, b, c] = versions[i - 1];
      const [x, y, z] = versions[i];
      const newer = a > x || (a === x && (b > y || (b === y && c > z)));
      assert.ok(newer, `v${a}.${b}.${c} must come before v${x}.${y}.${z}`);
    }
  });

  it("has no entry with a date and no version", () => {
    // An empty entry is a hole in the page: a month with nothing in it, which
    // reads as a release that never happened.
    const blocks = CHANGELOG.split("<div>").slice(1);
    for (const block of blocks) {
      assert.ok(/v\d+\.\d+\.\d+/.test(block), "every entry needs a version");
    }
  });
});
