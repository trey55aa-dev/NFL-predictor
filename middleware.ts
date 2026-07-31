// Vercel Edge Middleware — gates every request behind a signed session
// cookie. Runs before the static site or any /api route, on every path
// except the ones listed in `config.matcher` below (the login page and
// the two auth endpoints have to stay reachable, or nobody could ever
// sign in).
//
// Fails *closed*: if AUTH_SESSION_SECRET isn't set, every request gets a
// 500 rather than silently letting everyone through — a misconfigured
// deploy should be obviously broken, not invisibly open.
//
// Only runs on Vercel (Edge Middleware is a platform feature, not
// something `vite dev` executes) — plain `npm run dev` stays ungated, by
// design, so local testing doesn't need a login step.

import { verifySession } from "./lib/session";

export const config = {
  matcher: ["/((?!api/login|api/logout|login\\.html|favicon\\.ico).*)"],
};

const COOKIE_NAME = "nflp_session";

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const ALWAYS_ALLOWED = new Set(["/api/login", "/api/logout", "/login.html", "/favicon.ico"]);

export default async function middleware(request: Request): Promise<Response | undefined> {
  // Belt-and-suspenders: the `matcher` config above should already keep
  // middleware from running on these paths, but if that platform config
  // isn't honored for some reason, this check still prevents a hard
  // lockout — the login flow must never be gated by itself.
  const path = new URL(request.url).pathname;
  if (ALWAYS_ALLOWED.has(path)) return undefined;

  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) {
    return new Response(
      "Auth is not configured (missing AUTH_SESSION_SECRET). See README.md.",
      { status: 500 },
    );
  }

  const token = readCookie(request, COOKIE_NAME);
  const valid = await verifySession(crypto.subtle, secret, token);
  if (valid) return undefined; // let the request through as-is

  const url = new URL(request.url);
  return Response.redirect(new URL("/login.html", url.origin), 307);
}
