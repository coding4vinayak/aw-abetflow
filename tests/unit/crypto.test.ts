// The Blueprint (`generateValue: true`) hands the app a base64-encoded
// 256-bit key; an operator's `openssl rand -hex 32` hands it 64 hex chars.
// Both must open the same lock — and nothing shorter, longer, or garbled may.
// The bug this file exists to prevent: a strict hex-only parser rejecting the
// exact key Render generates, so credential sealing 500s on a fresh deploy.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sealCredential, openCredential } from "../../src/lib/crypto";

const original = process.env.ENCRYPTION_KEY;

function useKey(key: string | undefined) {
  if (key === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = key;
}

afterEach(() => {
  if (original === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = original;
});

describe("ENCRYPTION_KEY acceptance", () => {
  it("accepts 64 hex chars and round-trips a credential", () => {
    useKey(randomBytes(32).toString("hex"));
    const { ciphertext, iv } = sealCredential("sk-live-secret");
    assert.equal(openCredential(ciphertext, iv), "sk-live-secret");
  });

  it("accepts an 0x-prefixed hex key", () => {
    useKey("0x" + randomBytes(32).toString("hex"));
    const { ciphertext, iv } = sealCredential("value");
    assert.equal(openCredential(ciphertext, iv), "value");
  });

  it("accepts the base64 value Render's generateValue creates", () => {
    useKey(randomBytes(32).toString("base64")); // 256-bit base64, 44 chars
    const { ciphertext, iv } = sealCredential("render-generated");
    assert.equal(openCredential(ciphertext, iv), "render-generated");
  });

  it("rejects a missing key before anything is sealed", () => {
    useKey(undefined);
    assert.throws(() => sealCredential("x"), /ENCRYPTION_KEY is not set/);
  });

  it("rejects keys that are not 32 bytes — short hex, short base64, garbage", () => {
    useKey("abcd");
    assert.throws(() => sealCredential("x"), /32 bytes/);
    useKey(Buffer.alloc(31, 7).toString("base64"));
    assert.throws(() => sealCredential("x"), /32 bytes/);
    useKey("not-a-key");
    assert.throws(() => sealCredential("x"), /32 bytes/);
  });

  it("fails closed on tampering — AES-GCM auth, not garbage plaintext", () => {
    useKey(randomBytes(32).toString("hex"));
    const { ciphertext, iv } = sealCredential("sk-live");
    const [data, tag] = ciphertext.split(":");
    const flipped = (data[0] === "0" ? "1" : "0") + data.slice(1);
    assert.throws(() => openCredential(`${flipped}:${tag}`, iv));
  });
});
