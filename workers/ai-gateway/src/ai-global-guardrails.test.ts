import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { AiPausedError, checkEmergencyStop, DEFAULT_GUARDRAILS, guardrailConfig, requestReservation } from "./ai-global-guardrails";

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
    expect(() => requestReservation("gemini", "unpriced-model", geminiBody, 0, 0)).toThrow(AiPausedError);
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
});
