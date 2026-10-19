import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { AiPausedError, CircuitOpenError, checkEmergencyStop, costAdmission, DEFAULT_GUARDRAILS, guardrailConfig, requestReservation } from "./ai-global-guardrails";
import { sqliteD1 } from "./test-support/sqlite-d1";

describe("global AI guardrail configuration", () => {
  it("uses independent safe defaults and accepts bounded overrides", () => {
    expect(guardrailConfig(undefined)).toEqual(DEFAULT_GUARDRAILS);
    expect(guardrailConfig(JSON.stringify({ dailyCostUsdMicros: 0, gemini: { minuteRequests: 7, enabled: false } })))
      .toMatchObject({ dailyCostUsdMicros: 0, gemini: { minuteRequests: 7, enabled: false }, jev: DEFAULT_GUARDRAILS.jev });
    const first = guardrailConfig(undefined);
    first.gemini.dailyRequests = 0;
    expect(guardrailConfig(undefined).gemini.dailyRequests).toBe(DEFAULT_GUARDRAILS.gemini.dailyRequests);
  });

  it("fails closed for malformed, unknown, negative, fractional, or excessive settings", () => {
    expect(() => guardrailConfig("{")).toThrow();
    expect(() => guardrailConfig("")).toThrow();
    for (const raw of ["null", "[]", "{\"unknown\":1}", "{\"dailyCostUsdMicros\":-1}", "{\"monthlyCostUsdMicros\":1.5}", "{\"gemini\":{\"minuteRequests\":1000000001}}", "{\"jev\":{\"enabled\":0}}", "{\"gemini\":{\"newOption\":1}}"])
      expect(() => guardrailConfig(raw)).toThrow("invalid_guardrail_config");
  });

  it("honors the emergency stop and rejects invalid stop values", () => {
    expect(() => checkEmergencyStop(undefined)).not.toThrow();
    expect(() => checkEmergencyStop("false")).not.toThrow();
    expect(() => checkEmergencyStop("true")).toThrow(AiPausedError);
    for (const value of ["", "TRUE", "0", "yes"]) expect(() => checkEmergencyStop(value)).toThrow("invalid_guardrail_config");
  });

  it("reserves a conservative request amount for configured provider models", () => {
    const geminiBody = JSON.stringify({ model: "gemini-3.5-flash-lite", input: [{ type: "text", text: "synthetic prompt" }] });
    expect(requestReservation("gemini", "gemini-3.5-flash-lite", geminiBody, 0, 0)).toBeGreaterThanOrEqual(20_480);
    expect(requestReservation("gemini", "gemini-3.5-flash-lite", geminiBody, 50_000, 0)).toBe(50_000);
    const jevBody = JSON.stringify({ model: "jev-latest", questions: { item_0: {}, item_1: {} } });
    expect(requestReservation("jev", "jev-latest", jevBody, 0, 0)).toBeGreaterThan(0);
    // The OpenCode free model prices at zero, so only the configured floor remains.
    expect(requestReservation("jev", "jev-1.13-free", jevBody, 5_000, 0)).toBe(5_000);
    expect(requestReservation("jev", "jev-1.13", jevBody, 0, 0)).toBeGreaterThan(0);
    expect(() => requestReservation("gemini", "unpriced-model", geminiBody, 0, 0)).toThrow(AiPausedError);
    expect(() => requestReservation("jev", "unpriced-model", jevBody, 0, 0)).toThrow(AiPausedError);
  });

  it("backfills reservations for prior unknown events without rewriting settled price snapshots", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of ["0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql", "0004_ai_provider_costs.sql"])
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    db.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('synthetic-user','Test','test@example.invalid',0,0)").run();
    db.prepare(`INSERT INTO ai_provider_cost_events(id,user_id,provider,requested_model,model,pricing_version,billing_mode,input_usd_per_million_micros,output_usd_per_million_micros,metering_status,safe_error_code,dispatched_at,estimated_cost_usd_micros)
      VALUES ('gemini-unknown','synthetic-user','gemini','gemini-3.5-flash-lite','gemini-3.5-flash-lite','old-gemini-price','standard',300000,2500000,'unknown','usage_or_pricing_unknown',100,NULL),
        ('jev-unknown','synthetic-user','jev','jev-latest','jev-latest',NULL,NULL,NULL,NULL,'unknown','provider_timeout',101,NULL),
        ('settled','synthetic-user','gemini','gemini-3.5-flash-lite','gemini-3.5-flash-lite','old-gemini-price','standard',300000,2500000,'metered',NULL,102,42)`).run();
    db.exec(readFileSync(new URL("../migrations/0005_ai_global_guardrails.sql", import.meta.url), "utf8"));
    const rows = db.prepare("SELECT id,reserved_cost_usd_micros,pricing_version,input_usd_per_million_micros,estimated_cost_usd_micros FROM ai_provider_cost_events ORDER BY id").all();
    expect(rows).toEqual([
      { id: "gemini-unknown", reserved_cost_usd_micros: 50_000, pricing_version: "old-gemini-price", input_usd_per_million_micros: 300_000, estimated_cost_usd_micros: null },
      { id: "jev-unknown", reserved_cost_usd_micros: 5_000, pricing_version: null, input_usd_per_million_micros: null, estimated_cost_usd_micros: null },
      { id: "settled", reserved_cost_usd_micros: 0, pricing_version: "old-gemini-price", input_usd_per_million_micros: 300_000, estimated_cost_usd_micros: 42 },
    ]);
    db.close();
  });

  it("keeps one circuit per Jev upstream and reports an open circuit separately from other pauses", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const name of ["0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql", "0004_ai_provider_costs.sql", "0005_ai_global_guardrails.sql", "0017_jev_upstream_circuits.sql"])
      sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    sqlite.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('synthetic-user','Test','test@example.invalid',0,0)").run();
    sqlite.prepare(`INSERT INTO ai_provider_cost_events(id,user_id,provider,requested_model,model,metering_status,safe_error_code,dispatched_at,completed_at)
      VALUES ('opencode-1','synthetic-user','jev','jev-1.13-free','jev-1.13-free','unknown','provider_http_500',1790000098,1790000098),
        ('opencode-2','synthetic-user','jev','jev-1.13-free','jev-1.13-free','unknown','provider_http_500',1790000099,1790000099),
        ('openrouter-1','synthetic-user','jev','typesafe/jev-1.13','typesafe/jev-1.13','metered',NULL,1790000100,1790000100)`).run();
    const db = sqliteD1(sqlite);
    const now = 1_790_000_100;
    const config = guardrailConfig(JSON.stringify({ jev: { failureThreshold: 2, unknownThreshold: 100 } }));
    const opencodeBody = JSON.stringify({ model: "jev-1.13-free", questions: { item_0: {} } });
    await expect(costAdmission(db, "jev", "jev-1.13-free", opencodeBody, now, config, undefined, { key: "jev:opencode", model: "jev-1.13-free" }))
      .rejects.toBeInstanceOf(CircuitOpenError);
    // The sibling upstream has its own circuit, so it still admits.
    const openrouterBody = JSON.stringify({ model: "typesafe/jev-1.13", questions: { item_0: {} } });
    await expect(costAdmission(db, "jev", "typesafe/jev-1.13", openrouterBody, now, config, undefined, { key: "jev:openrouter", model: "typesafe/jev-1.13" }))
      .resolves.toBeDefined();
    expect(sqlite.prepare("SELECT provider FROM ai_provider_circuits ORDER BY provider").all()).toEqual([{ provider: "jev:opencode" }]);
    sqlite.close();
  });

  it("preserves an open Jev pause for both upstreams when the circuit is split", () => {
    const db = new DatabaseSync(":memory:");
    for (const name of ["0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql", "0004_ai_provider_costs.sql", "0005_ai_global_guardrails.sql"])
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    db.prepare("INSERT INTO ai_provider_circuits(provider,opened_at,reason) VALUES ('jev', 50, 'unknown_metering')").run();
    db.exec(readFileSync(new URL("../migrations/0017_jev_upstream_circuits.sql", import.meta.url), "utf8"));
    expect(db.prepare("SELECT provider,opened_at,reason FROM ai_provider_circuits ORDER BY provider").all()).toEqual([
      { provider: "jev:opencode", opened_at: 50, reason: "unknown_metering" },
      { provider: "jev:openrouter", opened_at: 50, reason: "unknown_metering" },
    ]);
    db.close();
  });
});
