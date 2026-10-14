/** Public contract shared by the browser, CLI and API. */
export type ApiScope = "read" | "write";
export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  source: "manual" | "cli";
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}
export interface DeviceRequestInfo {
  userCode: string;
  name: string;
  scopes: ApiScope[];
  expiresAt: string;
  tokenExpiresInDays: number;
}
