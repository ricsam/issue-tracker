import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";

test("real OIDC discovery, signed tokens, PKCE/state/nonce and identity boundaries", async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "test-key",
    use: "sig",
    alg: "RS256",
  };
  let profile = { sub: "subject-one", email: "person@example.com" };
  let defect: "none" | "nonce" | "issuer" | "pkce" | "signature" = "none";
  let userInfoOnly = false;
  let wrongUserInfoSubject = false;
  let userInfoReads = 0;
  const codes = new Map<
    string,
    { challenge: string; nonce: string; redirect: string }
  >();
  let exchanges = 0,
    jwksReads = 0;
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          userinfo_endpoint: issuer + "/userinfo",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      if (url.pathname === "/userinfo") {
        userInfoReads++;
        expect(request.headers.get("authorization")).toBe("Bearer test-access");
        return Response.json({
          ...profile,
          sub: wrongUserInfoSubject ? "wrong-subject" : profile.sub,
          email_verified: true,
          name: "UserInfo User",
        });
      }
      if (url.pathname === "/jwks") {
        jwksReads++;
        return Response.json({ keys: [jwk] });
      }
      if (url.pathname === "/authorize") {
        expect(url.searchParams.get("client_id")).toBe("client");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("scope")).toContain("openid");
        const code = crypto.randomUUID();
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge")!,
          nonce: url.searchParams.get("nonce")!,
          redirect: url.searchParams.get("redirect_uri")!,
        });
        const target = new URL(url.searchParams.get("redirect_uri")!);
        target.searchParams.set("code", code);
        target.searchParams.set("state", url.searchParams.get("state")!);
        return Response.redirect(target, 302);
      }
      if (url.pathname === "/token") {
        exchanges++;
        const body = new URLSearchParams(await request.text());
        const code = body.get("code")!;
        const flow = codes.get(code);
        codes.delete(code);
        if (!flow)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const challenge = Buffer.from(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(body.get("code_verifier")!),
          ),
        ).toString("base64url");
        if (challenge !== flow.challenge || defect === "pkce")
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        expect(body.get("redirect_uri")).toBe(flow.redirect);
        expect(body.get("grant_type")).toBe("authorization_code");
        const time = Math.floor(Date.now() / 1000);
        const payload = {
          iss: defect === "issuer" ? "https://wrong.example" : issuer,
          aud: "client",
          sub: profile.sub,
          email: userInfoOnly ? undefined : profile.email,
          email_verified: userInfoOnly ? undefined : true,
          name: "OIDC User",
          iat: time,
          exp: time + 300,
          nonce: defect === "nonce" ? "incorrect" : flow.nonce,
        };
        const unsigned =
          encode({ alg: "RS256", kid: "test-key", typ: "JWT" }) +
          "." +
          encode(payload);
        const signature = await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          keys.privateKey,
          new TextEncoder().encode(unsigned),
        );
        return Response.json({
          access_token: "test-access",
          token_type: "Bearer",
          expires_in: 300,
          id_token:
            unsigned +
            "." +
            Buffer.from(
              defect === "signature"
                ? new Uint8Array(256)
                : new Uint8Array(signature),
            ).toString("base64url"),
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const issuer: string = `http://127.0.0.1:${provider.port}`;
  const dir = mkdtempSync(join(tmpdir(), "issue-real-oidc-"));
  const app = createApp({
    dataDir: dir,
    baseUrl: "https://public.example",
    allowInsecureOidc: true,
  });
  const req = (path: string, method = "GET", body?: unknown, cookie = "") =>
    app.request(
      "http://internal:3000" + path,
      {
        method,
        headers: {
          Origin: "https://public.example",
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { remoteAddress: defect === "none" ? "192.0.2.1" : "192.0.2.2" },
    );
  const count = () =>
    (app.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  const begin = async () => {
    const login = await req("/api/auth/oidc/login");
    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const authorization = await fetch(login.headers.get("location")!, {
      redirect: "manual",
    });
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get("location")!);
    return { cookie, path: callback.pathname + callback.search };
  };
  try {
    const setup = await req("/api/auth/setup", "POST", {
      name: "Admin",
      email: "admin@example.com",
      password: "long-password-123",
    });
    expect(setup.status).toBe(200);
    const adminCookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const settings = {
      enabled: true,
      name: "Test issuer",
      issuer,
      clientId: "client",
      allowSignup: true,
    };
    expect(
      (await req("/api/admin/oidc", "PUT", settings, adminCookie)).status,
    ).toBe(200);
    const first = await begin();
    const success = await req(first.path, "GET", undefined, first.cookie);
    expect(success.status).toBe(302);
    expect(count()).toBe(2);
    expect(exchanges).toBe(1);
    expect(jwksReads).toBeGreaterThan(0);
    const userCookie = success.headers
      .get("set-cookie")!
      .split(",")
      .find((s) => s.trim().startsWith("session="))!
      .trim()
      .split(";")[0]!;
    const status = await (
      await req("/api/auth/status", "GET", undefined, userCookie)
    ).json();
    expect(status.user.email).toBe(profile.email);
    expect(status.user.role).toBe("member");
    const uid = status.user.id;
    expect((await req(first.path, "GET", undefined, first.cookie)).status).toBe(
      400,
    );
    expect(exchanges).toBe(1);
    profile = { ...profile, email: "changed@example.com" };
    const stable = await begin();
    expect(
      (await req(stable.path, "GET", undefined, stable.cookie)).status,
    ).toBe(302);
    expect(count()).toBe(2);
    expect(
      app.db
        .query("SELECT userId FROM identities WHERE issuer=? AND subject=?")
        .get(issuer, profile.sub),
    ).toEqual({ userId: uid });
    profile = { sub: "attacker", email: "admin@example.com" };
    const collision = await begin();
    expect(
      (await req(collision.path, "GET", undefined, collision.cookie)).status,
    ).toBe(400);
    expect(count()).toBe(2);
    await req(
      "/api/admin/oidc",
      "PUT",
      { ...settings, allowSignup: false },
      adminCookie,
    );
    profile = { sub: "new-person", email: "new@example.com" };
    const disabled = await begin();
    expect(
      (await req(disabled.path, "GET", undefined, disabled.cookie)).status,
    ).toBe(400);
    expect(count()).toBe(2);
    await req("/api/admin/oidc", "PUT", settings, adminCookie);
    const wrongState = await begin();
    const altered = new URL(wrongState.path, "https://public.example");
    altered.searchParams.set("state", "wrong");
    const before = exchanges;
    expect(
      (
        await req(
          altered.pathname + altered.search,
          "GET",
          undefined,
          wrongState.cookie,
        )
      ).status,
    ).toBe(400);
    expect(exchanges).toBe(before);
    expect(
      (await req(wrongState.path, "GET", undefined, wrongState.cookie)).status,
    ).toBe(400);
    userInfoOnly = true;
    profile = { sub: "subject-one", email: "changed@example.com" };
    defect = "nonce"; // Use a separate trusted test socket bucket for the remaining scenarios.
    const infoFlow = await begin();
    defect = "none";
    const infoResult = await app.request(
      "http://internal:3000" + infoFlow.path,
      { headers: { Cookie: infoFlow.cookie } },
      { remoteAddress: "192.0.2.3" },
    );
    expect(infoResult.status).toBe(302);
    expect(userInfoReads).toBe(1);
    expect(count()).toBe(2);
    wrongUserInfoSubject = true;
    defect = "nonce";
    const mismatch = await begin();
    defect = "none";
    expect(
      (
        await app.request(
          "http://internal:3000" + mismatch.path,
          { headers: { Cookie: mismatch.cookie } },
          { remoteAddress: "192.0.2.3" },
        )
      ).status,
    ).toBe(400);
    userInfoOnly = false;
    wrongUserInfoSubject = false;
    for (const error of ["nonce", "issuer", "pkce", "signature"] as const) {
      defect = error;
      const flow = await begin();
      expect((await req(flow.path, "GET", undefined, flow.cookie)).status).toBe(
        400,
      );
      expect(count()).toBe(2);
    }
  } finally {
    app.close();
    provider.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
