import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { handleAccountRequest, handleAuthRequest, type AccountEnv } from "./account-auth";

const origin = "http://localhost:8787";
const migration = readFileSync(new URL("../migrations/0001_auth.sql", import.meta.url), "utf8")
  .replace(/^--.*\n/gm, "")
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .join(";\n") + ";";
const authSecret = "better-auth-secret-for-d1-integration-test";
const bootstrapSecret = "operator-secret-for-d1-integration-test";
const instances: Miniflare[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

describe("Better Auth with local D1", () => {
  it("creates an invited account and generates real Passkey registration options from D1", async () => {
    const miniflare = new Miniflare({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      compatibilityDate: "2026-09-30",
      d1Databases: { ACCOUNT_DB: "kakeimatch-account-test" },
    });
    instances.push(miniflare);
    const d1 = await miniflare.getD1Database("ACCOUNT_DB");
    await d1.exec(migration);
    const env: AccountEnv = {
      ACCOUNT_DB: d1,
      BETTER_AUTH_SECRET: authSecret,
      ACCOUNT_BOOTSTRAP_SECRET: bootstrapSecret,
      CLOUD_ACCOUNT_ORIGIN: origin,
    };

    const inviteResponse = await handleAccountRequest(new Request(`${origin}/api/account/invites`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bootstrapSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "d1-invite@example.test", name: "D1 test member" }),
    }), env);
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json() as { context: string };

    const optionsResponse = await handleAuthRequest(new Request(
      `${origin}/api/auth/passkey/generate-register-options?context=${encodeURIComponent(invite.context)}`,
      { headers: { origin } },
    ), env);
    expect(optionsResponse.status).toBe(200);
    const options = await optionsResponse.json() as { challenge?: string; user?: { id?: string; name?: string } };
    expect(options.challenge).toBeTruthy();
    expect(options.user?.id).toBeTruthy();
    expect(options.user?.name).toBe("D1 test member");

    const accountTables = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const tableNames = (accountTables.results as Array<{ name: string }>).map((row) => row.name);
    expect(tableNames).not.toContain("receipt");
    expect(tableNames).not.toContain("statement");
  });
});
