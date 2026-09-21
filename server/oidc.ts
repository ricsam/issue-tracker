import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { z } from "zod";
import type { OidcSettings } from "../shared/types";

const inputSchema = z
  .object({
    enabled: z.boolean(),
    name: z.string().trim().min(1).max(100),
    issuer: z.string().trim().max(2048),
    clientId: z.string().trim().max(1024),
    allowSignup: z.boolean(),
    clientSecret: z.string().max(16384).optional(),
  })
  .strict();
type Stored = Omit<OidcSettings, "callbackUrl" | "hasClientSecret"> & {
  secret: string;
};
type Flow = { state: string; verifier: string; nonce: string };

export class OidcService {
  private readonly key: Buffer;
  private readonly callbackUrl: string;
  constructor(
    private readonly db: Database,
    private readonly options: {
      baseUrl: string;
      key: Buffer;
      allowInsecureLocalhost: boolean;
    },
  ) {
    if (options.key.length !== 32)
      throw new Error("Invalid OIDC encryption key");
    this.key = Buffer.from(options.key);
    try {
      const base = new URL(options.baseUrl);
      if (
        !["http:", "https:"].includes(base.protocol) ||
        base.username ||
        base.password
      )
        throw new Error();
      this.callbackUrl = new URL("/api/auth/oidc/callback", base).href;
      db.exec(
        "CREATE TABLE IF NOT EXISTS oidc_settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)",
      );
    } catch {
      throw new Error("Invalid OIDC configuration");
    }
  }

  private checkUrl(url: URL) {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.hash ||
      !(
        url.protocol === "https:" ||
        (this.options.allowInsecureLocalhost &&
          local &&
          url.protocol === "http:")
      )
    ) {
      throw new Error("Invalid OIDC URL");
    }
  }

  private stored(): Stored {
    const row = this.db
      .query("SELECT value FROM oidc_settings WHERE id = 1")
      .get() as { value: string } | null;
    return row
      ? JSON.parse(row.value)
      : {
          enabled: false,
          name: "Single sign-on",
          issuer: "",
          clientId: "",
          allowSignup: false,
          secret: "",
        };
  }

  settings(): OidcSettings {
    try {
      const { secret, ...settings } = this.stored();
      return {
        ...settings,
        hasClientSecret: !!secret,
        callbackUrl: this.callbackUrl,
      };
    } catch {
      throw new Error("Unable to read OIDC settings");
    }
  }

  update(input: unknown): OidcSettings {
    try {
      const { clientSecret, ...settings } = inputSchema.parse(input);
      if (settings.issuer) {
        const issuer = new URL(settings.issuer);
        this.checkUrl(issuer);
        if (issuer.search) throw new Error();
      }
      if (settings.enabled && (!settings.issuer || !settings.clientId))
        throw new Error();
      let secret = this.stored().secret;
      if (clientSecret) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const encrypted = Buffer.concat([
          cipher.update(clientSecret, "utf8"),
          cipher.final(),
        ]);
        secret = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
          "base64",
        );
      }
      this.db
        .query(
          "INSERT INTO oidc_settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
        )
        .run(JSON.stringify({ ...settings, secret }));
      return this.settings();
    } catch {
      throw new Error("Invalid OIDC settings");
    }
  }

  private async configuration() {
    const settings = this.stored();
    if (!settings.enabled) throw new Error();
    const issuer = new URL(settings.issuer);
    this.checkUrl(issuer);
    let secret: string | undefined;
    if (settings.secret) {
      const data = Buffer.from(settings.secret, "base64");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        data.subarray(0, 12),
      );
      decipher.setAuthTag(data.subarray(12, 28));
      secret = Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    }
    // Guard every outbound request, including JWKS, and never follow redirects
    // that could bypass the transport policy.
    const guardedFetch: oidc.CustomFetch = async (input, init) => {
      this.checkUrl(new URL(String(input)));
      const body =
        init.body instanceof Uint8Array ? Buffer.from(init.body) : init.body;
      return fetch(input, { ...init, body, redirect: "error" });
    };
    const config = await oidc.discovery(
      issuer,
      settings.clientId,
      secret,
      undefined,
      {
        [oidc.customFetch]: guardedFetch,
        execute: this.options.allowInsecureLocalhost
          ? [oidc.allowInsecureRequests]
          : undefined,
      },
    );
    // Verify token signatures against the issuer JWKS, in addition to TLS and claims.
    oidc.enableNonRepudiationChecks(config);
    const metadata = config.serverMetadata();
    if (metadata.issuer !== settings.issuer) throw new Error();
    for (const [key, value] of Object.entries(metadata)) {
      if (
        (key.endsWith("_endpoint") || key === "jwks_uri" || key === "issuer") &&
        typeof value === "string"
      ) {
        this.checkUrl(new URL(value));
      }
    }
    return config;
  }

  async login(): Promise<{
    url: string;
    state: string;
    verifier: string;
    nonce: string;
  }> {
    try {
      const config = await this.configuration();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: this.callbackUrl,
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      this.checkUrl(url);
      return { url: url.href, state, verifier, nonce };
    } catch {
      throw new Error("Unable to start OIDC login");
    }
  }

  async callback(
    url: URL,
    flow: Flow,
  ): Promise<{ issuer: string; subject: string; email: string; name: string }> {
    try {
      if (
        !flow.state ||
        !flow.verifier ||
        !flow.nonce ||
        url.origin + url.pathname !== this.callbackUrl
      )
        throw new Error();
      const config = await this.configuration();
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== "string" || !claims.sub)
        throw new Error();
      // Verified email is profile data only; identity matching uses issuer and subject.
      const profile =
        claims.email === undefined || claims.email_verified === undefined
          ? await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)
          : claims;
      const email = z.email().max(254).parse(profile.email).toLowerCase();
      if (profile.email_verified !== true) throw new Error();
      return {
        issuer: config.serverMetadata().issuer,
        subject: claims.sub,
        email,
        name:
          typeof profile.name === "string" && profile.name.trim()
            ? profile.name.trim().slice(0, 100)
            : email,
      };
    } catch {
      throw new Error("OIDC login failed");
    }
  }
}
