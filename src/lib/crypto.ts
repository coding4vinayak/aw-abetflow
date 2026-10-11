import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` " +
        "and export it before storing credentials.",
    );
  }
  const key = Buffer.from(raw.replace(/^0x/, ""), "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes, hex-encoded (64 hex chars).");
  }
  return key;
}

/**
 * Seal one credential value. The returned ciphertext is `data:tag` hex; the
 * iv travels alongside it. AES-256-GCM authenticates, so a tampered row
 * fails closed at decrypt time instead of decrypting to garbage.
 */
export function sealCredential(plaintext: string): { ciphertext: string; iv: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: `${data.toString("hex")}:${tag.toString("hex")}`,
    iv: iv.toString("hex"),
  };
}

/** Open what sealCredential sealed. Throws on tamper, wrong key, or bad shape. */
export function openCredential(ciphertext: string, ivHex: string): string {
  const [dataHex, tagHex] = ciphertext.split(":");
  if (!dataHex || !tagHex) throw new Error("Malformed credential ciphertext.");
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
