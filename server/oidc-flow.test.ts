import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { OidcService } from "./oidc";

test("OIDC cookie binding, replay prevention, proxy URL, immutable identity and no email linking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-oidc-flow-"));
  const app = createApp({ dataDir: dir, baseUrl: "https://public.example" });
  let identity = {
    issuer: "https://issuer.example",
    subject: "sub-1",
    email: "oidc@example.com",
    name: "OIDC",
  };
  const login = spyOn(OidcService.prototype, "login").mockResolvedValue({
    url: "https://issuer.example/auth",
    state: "state",
    nonce: "nonce",
    verifier: "verifier",
  });
  const callback = spyOn(OidcService.prototype, "callback").mockImplementation(
    async (url, flow) => {
      expect(url.origin).toBe("https://public.example");
      expect(flow).toEqual({
        state: "state",
        nonce: "nonce",
        verifier: "verifier",
      });
      return identity;
    },
  );
  let requestNumber = 0;
  const req = (path: string, method = "GET", body?: unknown, cookie = "") =>
    app.request("http://internal:3000" + path, {
      method,
      headers: {
        Origin: "https://public.example",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }, { remoteAddress: `192.0.2.${++requestNumber}` });
  try {
    const setup = await req("/api/auth/setup", "POST", {
      name: "Admin",
      email: "admin@example.com",
      password: "long-password-123",
    });
    const adminCookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const settings = {
      enabled: true,
      name: "SSO",
      issuer: "https://issuer.example",
      clientId: "client",
      allowSignup: true,
    };
    expect(
      (await req("/api/admin/oidc", "PUT", settings, adminCookie)).status,
    ).toBe(200);
    expect(
      (await req("/api/auth/oidc/callback?code=x&state=state")).status,
    ).toBe(400);
    expect(callback).not.toHaveBeenCalled();
    const flow = async () => {
      const start = await req("/api/auth/oidc/login");
      expect(start.status).toBe(302);
      return start.headers.getSetCookie().find((value) => value.startsWith("oidc_flow="))!.split(";")[0]!;
    };
    const cookie = await flow();
    expect(
      (
        await req(
          "/api/auth/oidc/callback?code=x&state=state",
          "GET",
          undefined,
          cookie,
        )
      ).status,
    ).toBe(302);
    expect(
      (
        await req(
          "/api/auth/oidc/callback?code=x&state=state",
          "GET",
          undefined,
          cookie,
        )
      ).status,
    ).toBe(400);
    for (const destination of ["/new", "/cli/authorize", "/cli/authorize?user_code=ABCD-EFGH", "/cli/authorize?user_code=ABCD-EFGH&next=https://evil.example", "//evil.example", "https://evil.example", "/new/", "/new?next=https://evil.example", "/\\evil.example", "%2Fnew"]) {
      const start = await req(`/api/auth/oidc/login?returnTo=${encodeURIComponent(destination)}`);
      const cookies = start.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      const result = await req("/api/auth/oidc/callback?code=x&state=state", "GET", undefined, cookies);
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe(["/new", "/cli/authorize", "/cli/authorize?user_code=ABCD-EFGH"].includes(destination) ? destination : "/");
      expect(result.headers.getSetCookie().some((value) => value.startsWith("oidc_return=;") && value.includes("Max-Age=0"))).toBe(true);
    }
    // Even a forged return cookie cannot create an open redirect.
    const tampered = await req("/api/auth/oidc/callback?code=x&state=state", "GET", undefined, `${await flow()}; oidc_return=https%3A%2F%2Fevil.example`);
    expect(tampered.headers.get("location")).toBe("/");
    identity = { ...identity, email: "changed@example.com" };
    expect(
      (
        await req(
          "/api/auth/oidc/callback?code=x&state=state",
          "GET",
          undefined,
          await flow(),
        )
      ).status,
    ).toBe(302);
    expect(
      (app.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number })
        .n,
    ).toBe(2);
    identity = { ...identity, subject: "attacker", email: "admin@example.com" };
    expect(
      (
        await req(
          "/api/auth/oidc/callback?code=x&state=state",
          "GET",
          undefined,
          await flow(),
        )
      ).status,
    ).toBe(400);
    await req(
      "/api/admin/oidc",
      "PUT",
      { ...settings, allowSignup: false },
      adminCookie,
    );
    identity = { ...identity, subject: "new", email: "new@example.com" };
    expect(
      (
        await req(
          "/api/auth/oidc/callback?code=x&state=state",
          "GET",
          undefined,
          await flow(),
        )
      ).status,
    ).toBe(400);
  } finally {
    login.mockRestore();
    callback.mockRestore();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
