import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import middleware from "../../middleware";
import { signSession } from "../../lib/session";

const SECRET = "middleware-test-secret";

function req(path: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new Request(`https://example.test${path}`, { headers });
}

describe("middleware", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lets the login page, login API, and logout API through unconditionally", async () => {
    for (const path of ["/login.html", "/api/login", "/api/logout"]) {
      expect(await middleware(req(path))).toBeUndefined();
    }
  });

  it("lets a request through when it carries a valid session cookie", async () => {
    const token = await signSession(crypto.subtle, SECRET, 3600);
    const result = await middleware(req("/", `nflp_session=${token}`));
    expect(result).toBeUndefined();
  });

  it("redirects to /login.html when there's no session cookie", async () => {
    const result = await middleware(req("/"));
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(307);
    expect(result!.headers.get("location")).toBe("https://example.test/login.html");
  });

  it("redirects when the session cookie is expired or forged", async () => {
    const expired = await signSession(crypto.subtle, SECRET, -10); // already expired
    const forged = "bm90LWEtcmVhbC10b2tlbg.ZmFrZS1zaWc";
    for (const cookie of [`nflp_session=${expired}`, `nflp_session=${forged}`]) {
      const result = await middleware(req("/agenda", cookie));
      expect(result?.status).toBe(307);
    }
  });

  it("finds the session cookie among other cookies", async () => {
    const token = await signSession(crypto.subtle, SECRET, 3600);
    const result = await middleware(req("/", `other=1; nflp_session=${token}; another=2`));
    expect(result).toBeUndefined();
  });

  it("fails closed with a 500 when AUTH_SESSION_SECRET isn't configured", async () => {
    vi.unstubAllEnvs();
    const result = await middleware(req("/"));
    expect(result?.status).toBe(500);
  });
});
