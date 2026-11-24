import { describe, expect, it, vi } from "vitest";
import { ADMIN_OPERATOR_PRINCIPAL_ID, handleAdminRequest, requireAdmin, type AdminEnv } from "./admin";

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

type TokenOptions = {
  audience?: string;
  issuer?: string;
  kid?: string;
  email?: string | null;
  sub?: string | null;
  commonName?: string;
  expOffsetSeconds?: number;
  now?: number;
};

async function createSigner() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const sign = async (options: TokenOptions = {}) => {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const kid = options.kid ?? "key-1";
    const header = encode({ alg: "RS256", typ: "JWT", kid });
    const claims: Record<string, unknown> = {
      iss: options.issuer ?? "https://example.cloudflareaccess.com",
      aud: [options.audience ?? "admin-aud"],
      exp: now + (options.expOffsetSeconds ?? 60),
    };
    if (options.email !== null) claims.email = options.email === undefined ? "admin@example.test" : options.email;
    if (options.sub !== null) claims.sub = options.sub === undefined ? "sub-admin-1" : options.sub;
    if (options.commonName !== undefined) claims.common_name = options.commonName;
    const payload = encode(claims);
    const signature = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
    );
    let binary = "";
    for (const byte of signature) binary += String.fromCharCode(byte);
    return `${header}.${payload}.${btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
  };
  const jwks = (kid = "key-1") => ({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] });
  return { sign, jwks };
}

const envBase = (): AdminEnv => ({
  ACCOUNT_DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ success: true }) }) }), batch: async () => [] },
  CF_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  CF_ACCESS_AUD: "admin-aud",
  ADMIN_ACCESS_EMAILS: "admin@example.test, ops@example.test",
  CLOUD_ACCOUNT_ORIGIN: "https://kakeimatch.example",
});

function request(headers: Record<string, string> = {}) {
  return new Request("https://kakeimatch.example/api/admin/overview", { headers });
}

describe("admin authorization", () => {
  it("fails closed with 503 when Access settings or email allowlist are missing or partial", async () => {
    const { sign } = await createSigner();
    const jwt = await sign();
    const fetchImpl = vi.fn<typeof fetch>();

    const cases: Array<(env: AdminEnv) => void> = [
      env => { delete env.CF_ACCESS_TEAM_DOMAIN; delete env.CF_ACCESS_AUD; },
      env => { delete env.CF_ACCESS_AUD; },
      env => { delete env.CF_ACCESS_TEAM_DOMAIN; },
      env => { env.CF_ACCESS_AUD = "   "; },
      env => { env.CF_ACCESS_TEAM_DOMAIN = "http://example.cloudflareaccess.com"; },
      env => { env.CF_ACCESS_TEAM_DOMAIN = "https://attacker.example"; },
      env => { env.CF_ACCESS_TEAM_DOMAIN = "not-a-url"; },
      env => { delete env.ADMIN_ACCESS_EMAILS; },
      env => { env.ADMIN_ACCESS_EMAILS = " , "; },
    ];

    for (const mutate of cases) {
      const env = envBase();
      mutate(env);
      const result = await requireAdmin(request({ "cf-access-jwt-assertion": jwt }), env, { fetchImpl });
      expect("response" in result && result.response.status).toBe(503);
      if ("response" in result) expect(result.response.headers.get("cache-control")).toBe("no-store");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows an email in ADMIN_ACCESS_EMAILS without Better Auth session or ADMIN_USER_IDS", async () => {
    const { sign, jwks } = await createSigner();
    const env = envBase();
    const jwt = await sign({ email: "Admin@Example.Test", sub: "cf-sub-1" });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(jwks()), { headers: { "content-type": "application/json" } }));

    const result = await requireAdmin(request({ "cf-access-jwt-assertion": jwt }), env, { fetchImpl });
    expect(result).toEqual({ adminSubject: "access:cf-sub-1", principalId: ADMIN_OPERATOR_PRINCIPAL_ID });
  });

  it("rejects missing JWT, invalid signatures, wrong aud/iss, expired JWT, disallowed emails, and service tokens", async () => {
    const primary = await createSigner();
    const attacker = await createSigner();
    const env = envBase();
    const now = 1_800_000_000;
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(primary.jwks()), { headers: { "content-type": "application/json" } });

    const validJwt = await primary.sign({ now });
    const tamperedParts = validJwt.split(".");
    tamperedParts[2] = (tamperedParts[2][0] === "A" ? "B" : "A") + tamperedParts[2].slice(1);
    const untrustedKeyJwt = await attacker.sign({ now });
    const wrongAudJwt = await primary.sign({ audience: "other-aud", now });
    const wrongIssJwt = await primary.sign({ issuer: "https://attacker.example", now });
    const expiredJwt = await primary.sign({ expOffsetSeconds: -1, now });
    const disallowedEmailJwt = await primary.sign({ email: "member@example.test", now });
    const serviceTokenNoEmailEmptySub = await primary.sign({ email: null, sub: "", commonName: "ci-service-token", now });
    const serviceTokenNoEmailWithSub = await primary.sign({ email: null, sub: "svc-sub-1", commonName: "ci-service-token", now });
    const missingSubJwt = await primary.sign({ sub: null, now });
    const emptySubJwt = await primary.sign({ sub: "   ", now });

    const rejectedRequests: Request[] = [
      request(),
      request({ "cf-access-jwt-assertion": tamperedParts.join(".") }),
      request({ "cf-access-jwt-assertion": untrustedKeyJwt }),
      request({ "cf-access-jwt-assertion": wrongAudJwt }),
      request({ "cf-access-jwt-assertion": wrongIssJwt }),
      request({ "cf-access-jwt-assertion": expiredJwt }),
      request({ "cf-access-jwt-assertion": disallowedEmailJwt }),
      request({ "cf-access-jwt-assertion": serviceTokenNoEmailEmptySub }),
      request({ "cf-access-jwt-assertion": serviceTokenNoEmailWithSub }),
      request({ "cf-access-jwt-assertion": missingSubJwt }),
      request({ "cf-access-jwt-assertion": emptySubJwt }),
      request({ "cf-access-jwt-assertion": validJwt, origin: "https://attacker.example" }),
    ];

    for (const req of rejectedRequests) {
      const result = await requireAdmin(req, env, { fetchImpl, nowSeconds: () => now });
      expect("response" in result && result.response.status).toBe(403);
      if ("response" in result) expect(result.response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("returns no-store for rejected admin API responses", async () => {
    const missingJwt = await handleAdminRequest(request(), envBase());
    expect(missingJwt.status).toBe(403);
    expect(missingJwt.headers.get("cache-control")).toBe("no-store");

    const unconfiguredEnv = envBase();
    delete unconfiguredEnv.CF_ACCESS_AUD;
    const unconfigured = await handleAdminRequest(request(), unconfiguredEnv);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get("cache-control")).toBe("no-store");
  });
});
