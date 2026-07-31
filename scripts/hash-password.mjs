#!/usr/bin/env node
// Run once to turn your chosen password into the value Vercel stores —
// the plaintext password itself never gets typed anywhere but here.
//
//   node scripts/hash-password.mjs "your-password-here"
//
// Copy the printed value into the AUTH_PASSWORD_HASH env var (see README).
//
// Mirrors lib/password.ts's hashPassword() — plain JS here (not TS) so this
// runs with a bare `node`, no build step. Keep the two in sync if the
// stored-hash format ever changes.
import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash-password.mjs <password>");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);
console.log(`${salt.toString("hex")}:${hash.toString("hex")}`);
