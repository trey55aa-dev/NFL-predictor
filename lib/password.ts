/**
 * Password hashing for the single-user login. Node's built-in `scrypt` —
 * no dependency, no bcrypt native bindings to worry about on Vercel's
 * serverless runtime. Stored form is `<salt-hex>:<hash-hex>`, meant to
 * live only in the AUTH_PASSWORD_HASH environment variable — never in
 * code or in the client bundle (this module is only ever imported from
 * `api/*.ts`, which runs server-side).
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;
  const candidate = scryptSync(password, salt, KEY_LENGTH);
  return timingSafeEqual(candidate, expected);
}
