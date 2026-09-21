import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OidcService } from "./oidc";

const input = {
  enabled: true,
  name: "SSO",
  issuer: "https://issuer.example",
  clientId: "app",
  allowSignup: false,
};
function fixture(allowInsecureLocalhost = false) {
  const db = new Database(":memory:");
  const service = new OidcService(db, {
    baseUrl: "https://app.example",
    key: Buffer.alloc(32, 7),
    allowInsecureLocalhost,
  });
  return { db, service };
}

test("defaults disabled and owns its table", () => {
  const { db, service } = fixture();
  try {
    expect(service.settings().enabled).toBe(false);
    expect(service.settings().callbackUrl).toBe(
      "https://app.example/api/auth/oidc/callback",
    );
  } finally {
    db.close();
  }
});

test("encrypts secrets, hides them, and preserves omitted or empty secrets", () => {
  const { db, service } = fixture();
  try {
    const settings = service.update({
      ...input,
      clientSecret: "very-private-secret",
    });
    expect(settings.hasClientSecret).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("very-private-secret");
    const original = db.query("SELECT value FROM oidc_settings").get();
    expect(JSON.stringify(original)).not.toContain("very-private-secret");
    service.update(input);
    expect(db.query("SELECT value FROM oidc_settings").get()).toEqual(original);
    service.update({ ...input, clientSecret: "" });
    expect(db.query("SELECT value FROM oidc_settings").get()).toEqual(original);
  } finally {
    db.close();
  }
});

test("validates configuration and restricts insecure issuers", () => {
  const { db, service } = fixture();
  try {
    for (const issuer of [
      "http://example.com",
      "http://localhost:9000",
      "https://user:password@example.com",
      "https://example.com/#fragment",
    ]) {
      expect(() => service.update({ ...input, issuer })).toThrow(
        "Invalid OIDC settings",
      );
    }
    expect(() => service.update({ ...input, enabled: "true" })).toThrow();
    expect(() => service.update({ ...input, clientId: "" })).toThrow();
    expect(service.settings().enabled).toBe(false);
  } finally {
    db.close();
  }
});

test("explicit development option permits only loopback HTTP", () => {
  const { db, service } = fixture(true);
  try {
    service.update({ ...input, issuer: "http://localhost:9000" });
    expect(() =>
      service.update({ ...input, issuer: "http://localhost.evil.example" }),
    ).toThrow();
    expect(() =>
      service.update({ ...input, issuer: "http://192.168.1.1" }),
    ).toThrow();
  } finally {
    db.close();
  }
});

test("disabled login and malformed callback fail generically", async () => {
  const { db, service } = fixture();
  try {
    await expect(service.login()).rejects.toThrow("Unable to start OIDC login");
    await expect(
      service.callback(new URL("https://app.example/api/auth/oidc/callback"), {
        state: "",
        verifier: "",
        nonce: "",
      }),
    ).rejects.toThrow("OIDC login failed");
  } finally {
    db.close();
  }
});

test("discovery rejects nonlocal HTTP endpoints even in development", async () => {
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const issuer = new URL(request.url).origin;
      return Response.json({
        issuer,
        authorization_endpoint: "http://insecure.example/authorize",
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    },
  });
  const { db, service } = fixture(true);
  try {
    service.update({ ...input, issuer: `http://127.0.0.1:${provider.port}` });
    await expect(service.login()).rejects.toThrow("Unable to start OIDC login");
  } finally {
    provider.stop(true);
    db.close();
  }
});
