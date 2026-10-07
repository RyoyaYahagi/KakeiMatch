import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminRequest, requireAdmin, type AdminEnv } from "./admin";

const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("./account-auth", () => ({
  getAccountSession: async () => authState.session,
}));

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function accessToken(audience = "admin-aud", issuer = "https://example.cloudflareaccess.com", kid = "key-1") {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const header = encode({ alg: "RS256", typ: "JWT", kid });
  const payload = encode({ iss: issuer, aud: [audience], exp: Math.floor(Date.now() / 1000) + 60 });
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  const jwt = `${header}.${payload}.${btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
  return { jwt, jwks: { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] } };
}

const envBase = (): AdminEnv => ({
  ACCOUNT_DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ success: true }) }) }), batch: async () => [] },
  BETTER_AUTH_SECRET: "synthetic-better-auth-secret-long-enough",
  ADMIN_USER_IDS: "admin-user, another-admin",
  CLOUD_ACCOUNT_ORIGIN: "https://kakeimatch.example",
});

function request(headers: Record<string, string> = {}) {
  return new Request("https://kakeimatch.example/api/admin/overview", { headers });
}

describe("admin authorization", () => {
  beforeEach(() => { authState.session = null; });

  it("fails closed when the allowlist is absent", async () => {
    const env = envBase();
    delete env.ADMIN_USER_IDS;
    const result = await requireAdmin(request(), env);
    expect("response" in result && result.response.status).toBe(503);
  });

  it("requires a valid Better Auth session and the server-side user ID allowlist", async () => {
    const env = envBase();
    expect(await requireAdmin(request(), env).then(result => "response" in result && result.response.status)).toBe(401);
    authState.session = { user: { id: "regular-user", email: "user@example.test", name: "User" }, session: { id: "s", expiresAt: new Date(Date.now() + 60_000) } };
    expect(await requireAdmin(request(), env).then(result => "response" in result && result.response.status)).toBe(403);
    authState.session = { user: { id: "admin-user", email: "admin@example.test", name: "Admin" }, session: { id: "s", expiresAt: new Date(Date.now() + 60_000) } };
    const result = await requireAdmin(request(), env);
    expect(result).toEqual({ userId: "admin-user" });
  });

  it("verifies Cloudflare Access signature, issuer and audience when configured", async () => {
    const env = envBase();
    env.CF_ACCESS_TEAM_DOMAIN = "https://example.cloudflareaccess.com";
    env.CF_ACCESS_AUD = "admin-aud";
    authState.session = { user: { id: "admin-user", email: "admin@example.test", name: "Admin" }, session: { id: "s", expiresAt: new Date(Date.now() + 60_000) } };
    const { jwt, jwks } = await accessToken();
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } });
    expect(await requireAdmin(request({ "cf-access-jwt-assertion": jwt }), env, { fetchImpl }).then(result => "userId" in result)).toBe(true);
    expect(await requireAdmin(request(), env, { fetchImpl }).then(result => "response" in result && result.response.status)).toBe(403);
    const parts = jwt.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    expect(await requireAdmin(request({ "cf-access-jwt-assertion": parts.join('.') }), env, { fetchImpl }).then(result => "response" in result && result.response.status)).toBe(403);
    expect(await requireAdmin(request({ "cf-access-jwt-assertion": jwt }), env, { fetchImpl, nowSeconds: () => Math.floor(Date.now() / 1000) + 120 }).then(result => "response" in result && result.response.status)).toBe(403);
    const { jwt: wrongIssuer } = await accessToken('admin-aud', 'https://attacker.example');
    expect(await requireAdmin(request({ "cf-access-jwt-assertion": wrongIssuer }), env, { fetchImpl }).then(result => "response" in result && result.response.status)).toBe(403);
    const { jwt: wrongAud } = await accessToken("other-aud");
    expect(await requireAdmin(request({ "cf-access-jwt-assertion": wrongAud }), env, { fetchImpl }).then(result => "response" in result && result.response.status)).toBe(403);
  });

  it("returns no-store for rejected admin API responses", async () => {
    const response = await handleAdminRequest(request(), envBase());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
