// Login endpoint for the single-user auth gate. Verifies the submitted
// password against AUTH_PASSWORD_HASH (never the plaintext password —
// that only ever existed on your machine when you ran
// scripts/hash-password.mjs) and, on success, sets a signed session
// cookie that middleware.ts checks on every subsequent request.
//
// Minimal req/res interface (matches api/advanced.ts's pattern) instead of
// pulling in @vercel/node — Vercel's Node.js runtime already parses a
// JSON request body into req.body for you.

import { webcrypto } from "node:crypto";
import { verifyPassword } from "../lib/password";
import { signSession } from "../lib/session";

const COOKIE_NAME = "nflp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

interface ApiRequest {
  method?: string;
  body?: unknown;
}
interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const expectedUser = process.env.AUTH_USERNAME;
  const expectedHash = process.env.AUTH_PASSWORD_HASH;
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!expectedUser || !expectedHash || !secret) {
    res.status(500).json({ error: "Auth is not configured on the server. See README.md." });
    return;
  }

  const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (username !== expectedUser || !password || !verifyPassword(password, expectedHash)) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  // Node's webcrypto.subtle and the DOM lib's SubtleCrypto type are
  // structurally the same at runtime; TS's lib.dom types are just
  // stricter than Node's about ArrayBuffer vs ArrayBufferLike generics.
  const subtle = webcrypto.subtle as unknown as SubtleCrypto;
  const token = await signSession(subtle, secret, SESSION_TTL_SECONDS);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
  );
  res.status(200).json({ ok: true });
}
