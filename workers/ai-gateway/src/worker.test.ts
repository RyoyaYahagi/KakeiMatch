import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleRequest, type GatewayEnv } from "./worker";

const secret = "synthetic-ai-gateway-signing-secret-for-tests";
const now = 1_800_000_000;
const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");
function bearer(sub = "synthetic-user", claims: Record<string, unknown> = {}): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ sub, aud: "kakeimatch-ai", iat: now, exp: now + 300, ...claims }));
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  return `Bearer ${head}.${body}.${b64url(signature)}`;
}
function makeRequest(path: string, body: unknown, authorization = bearer(), headers: Record<string, string> = {}): Request {
  const url = `https://kakeimatch-pr-36.workers.dev${path}`;
  return new Request(url, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json", authorization, ...headers }, body: JSON.stringify(body) });
}
function env(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return { AI_GATEWAY_AUTH_SECRET: secret, GEMINI_API_KEY: "synthetic-gemini-key", TYPESAFE_API_KEY: "synthetic-jev-key", AI_USER_RATE_LIMIT: { limit: vi.fn(async () => ({ success: true })) }, ...overrides };
}
const fetchOk = (value: unknown, status = 200): typeof fetch => vi.fn(async () => Response.json(value, { status })) as typeof fetch;
const receipt = { documentKind: "receipt", merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: "12:30", totalAmountYen: 3284, taxAmountYen: null, items: [{ name: "Synthetic Item", amountYen: 3284 }], warnings: [] };
const jev = { model: "jev-latest", answers: { category: { type: "choice", choice: "food", probabilities: { food: 0.9, household: 0.02, transport: 0.01, medical: 0.01, clothing: 0.01, entertainment: 0.01, utilities: 0.01, communications: 0.01, other: 0.02 }, confidence: 0.9 } } };

describe("AI gateway", () => {
  it("requires a signed AI-only identity token and same-origin call", async () => {
    const request = makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 100, items: [] } }, "Bearer invalid");
    expect((await handleRequest(request, env(), { nowSeconds: () => now })).status).toBe(401);
    const foreign = new Request(request, { headers: { origin: "https://attacker.invalid" } });
    expect((await handleRequest(foreign, env(), { nowSeconds: () => now })).status).toBe(403);
  });

  it("rejects expired, overlong, and wrong-audience tokens", async () => {
    for (const claims of [{ exp: now }, { exp: now + 901 }, { aud: "other" }]) {
      const request = makeRequest("/api/ai/jev", {}, bearer("synthetic-user", claims));
      expect((await handleRequest(request, env(), { nowSeconds: () => now })).status).toBe(401);
    }
  });

  it("enforces user keyed rate limits and fails closed without the binding", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const response = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 100, items: [] } }), env({ AI_USER_RATE_LIMIT: { limit } }), { nowSeconds: () => now });
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "synthetic-user:jev" });
    expect((await handleRequest(makeRequest("/api/ai/jev", {}), env({ AI_USER_RATE_LIMIT: undefined }), { nowSeconds: () => now })).status).toBe(503);
  });

  it("rejects oversized and malformed requests before calling a provider", async () => {
    const provider = fetchOk(jev);
    const tooLarge = new Request("https://kakeimatch-pr-36.workers.dev/api/ai/jev", { method: "POST", headers: { origin: "https://kakeimatch-pr-36.workers.dev", "content-type": "application/json", authorization: bearer(), "content-length": "10000000" }, body: "{}" });
    expect((await handleRequest(tooLarge, env(), { nowSeconds: () => now, fetchImpl: provider })).status).toBe(413);
    expect((await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 4.4, items: [] } }), env(), { nowSeconds: () => now, fetchImpl: provider })).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it("sends only validated category facts to Jev and never returns its secret or extra data", async () => {
    const provider = fetchOk({ ...jev, extra: "provider detail" });
    const response = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: " Synthetic Shop ", totalAmountYen: 3284, items: [{ name: " Synthetic Item ", amountYen: 3284 }], ignored: "drop" } }), env(), { nowSeconds: () => now, fetchImpl: provider });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(jev);
    const [url, init] = vi.mocked(provider).mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-jev-key");
    expect(JSON.parse(String(init?.body)).state.receipt).toEqual({ merchant: "Synthetic Shop", totalAmountYen: 3284, items: [{ name: "Synthetic Item", amountYen: 3284 }] });
  });

  it("sends receipt bytes to Gemini only for the Gemini route and validates output", async () => {
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64");
    const provider = fetchOk({ output_text: JSON.stringify(receipt) });
    const response = await handleRequest(makeRequest("/api/ai/gemini", { contentType: "image/png", imageBase64: pngBase64 }), env(), { nowSeconds: () => now, fetchImpl: provider });
    expect(response.status).toBe(200);
    const responseBody = await response.text();
    expect(JSON.parse(responseBody)).toEqual(receipt);
    expect(responseBody).not.toContain("synthetic-gemini-key");
    const [, init] = vi.mocked(provider).mock.calls[0];
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("synthetic-gemini-key");
    expect(JSON.parse(String(init?.body)).store).toBe(false);
    const invalid = await handleRequest(makeRequest("/api/ai/gemini", { contentType: "image/png", imageBase64: Buffer.from("not a png").toString("base64") }), env(), { nowSeconds: () => now, fetchImpl: provider });
    expect(invalid.status).toBe(400);
  });

  it("normalizes upstream failures and rejects malformed provider responses", async () => {
    const request = makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 10, items: [] } });
    const privateError = await handleRequest(request, env(), { nowSeconds: () => now, fetchImpl: fetchOk({ message: "synthetic sensitive upstream detail" }, 500) });
    expect(privateError.status).toBe(503);
    expect(await privateError.text()).not.toContain("synthetic sensitive upstream detail");
    const malformed = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 10, items: [] } }), env(), { nowSeconds: () => now, fetchImpl: fetchOk({ model: "jev-latest", answers: {} }) });
    expect(malformed.status).toBe(502);
  });
});
