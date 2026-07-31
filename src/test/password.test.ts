import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../../lib/password";

describe("hashPassword + verifyPassword", () => {
  it("verifies the correct password against its own hash", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt) but both verify", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same-password", a)).toBe(true);
    expect(verifyPassword("same-password", b)).toBe(true);
  });

  it("rejects malformed stored hashes without throwing", () => {
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "no-colon-here")).toBe(false);
    expect(verifyPassword("anything", "not-hex:also-not-hex")).toBe(false);
    expect(verifyPassword("anything", "aa:bb")).toBe(false); // wrong length hash
  });

  it("is case- and whitespace-sensitive", () => {
    const hash = hashPassword("Secret123");
    expect(verifyPassword("secret123", hash)).toBe(false);
    expect(verifyPassword("Secret123 ", hash)).toBe(false);
  });
});
