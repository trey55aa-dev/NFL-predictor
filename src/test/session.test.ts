import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { signSession, verifySession } from "../../lib/session";

const subtle = webcrypto.subtle as unknown as SubtleCrypto;
const SECRET = "test-secret-do-not-use-in-prod";

describe("signSession + verifySession", () => {
  it("round-trips: a freshly signed token verifies as valid", async () => {
    const token = await signSession(subtle, SECRET, 3600);
    expect(await verifySession(subtle, SECRET, token)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession(subtle, SECRET, 3600);
    expect(await verifySession(subtle, "wrong-secret", token)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const now = Date.now();
    const token = await signSession(subtle, SECRET, 60, now); // expires in 60s
    const stillValid = await verifySession(subtle, SECRET, token, now + 30_000);
    const expired = await verifySession(subtle, SECRET, token, now + 120_000);
    expect(stillValid).toBe(true);
    expect(expired).toBe(false);
  });

  it("rejects a tampered payload (expiry pushed into the future)", async () => {
    const token = await signSession(subtle, SECRET, 60);
    const [payloadB64, sig] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ exp: Date.now() + 999_999_999 })).toString(
      "base64url",
    );
    expect(await verifySession(subtle, SECRET, `${tamperedPayload}.${sig}`)).toBe(false);
    // sanity: original untouched token still verifies fine
    expect(await verifySession(subtle, SECRET, `${payloadB64}.${sig}`)).toBe(true);
  });

  it("rejects malformed tokens without throwing", async () => {
    expect(await verifySession(subtle, SECRET, undefined)).toBe(false);
    expect(await verifySession(subtle, SECRET, "")).toBe(false);
    expect(await verifySession(subtle, SECRET, "no-dot-here")).toBe(false);
    expect(await verifySession(subtle, SECRET, "not-base64!!.also-not-base64!!")).toBe(false);
    expect(await verifySession(subtle, SECRET, ".")).toBe(false);
  });
});
