// Clears the session cookie by re-setting it already-expired, then sends
// the browser back to the login page.

interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

export default async function handler(_req: unknown, res: ApiResponse) {
  res.setHeader("Set-Cookie", "nflp_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.status(200).json({ ok: true });
}
