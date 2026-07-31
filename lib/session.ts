/**
 * Signed session tokens, built only on the Web Crypto (SubtleCrypto) API so
 * the exact same code verifies a session in Vercel's Edge Middleware
 * (which has no Node `crypto` module) and signs one in the Node.js login
 * function (via `node:crypto`'s `webcrypto` export) — one implementation,
 * two runtimes, no risk of the two disagreeing on the signature format.
 *
 * Token shape: `<base64url(JSON payload)>.<base64url(HMAC-SHA256 sig)>`.
 * The payload is just an expiry — there's nothing else to a single-user
 * session worth carrying.
 */

export interface SessionPayload {
  exp: number; // ms since epoch
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(subtle: SubtleCrypto, secret: string): Promise<CryptoKey> {
  return subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSession(
  subtle: SubtleCrypto,
  secret: string,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<string> {
  const payload: SessionPayload = { exp: now + ttlSeconds * 1000 };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(subtle, secret);
  const sig = await subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Verifies the signature (constant-time, via subtle.verify) and the expiry. */
export async function verifySession(
  subtle: SubtleCrypto,
  secret: string,
  token: string | undefined | null,
  now: number = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!payloadB64 || !sigB64) return false;

  const key = await hmacKey(subtle, secret);
  let sigBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(sigB64);
    payloadBytes = fromBase64Url(payloadB64);
  } catch {
    return false;
  }
  const ok = await subtle.verify(
    "HMAC",
    key,
    sigBytes as BufferSource,
    new TextEncoder().encode(payloadB64),
  );
  if (!ok) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    return typeof payload.exp === "number" && payload.exp > now;
  } catch {
    return false;
  }
}
