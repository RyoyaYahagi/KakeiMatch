import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { deleteAccountData, handleAccountRequest, handleAuthRequest, type AccountEnv } from "./account-auth";

const origin = "http://localhost:8787";
const migrations = [
  "0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql",
  "0004_ai_provider_costs.sql", "0005_ai_global_guardrails.sql", "0006_contact_submissions.sql",
  "0007_account_deletion.sql",
].map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
const migrationSql = migrations
  .map(migration => migration.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim())
  .join("\n");
type MigrationDatabase = Pick<Awaited<ReturnType<Miniflare["getD1Database"]>>, "exec">;
const applyMigrations = (d1: MigrationDatabase) => d1.exec(migrationSql);
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
    await applyMigrations(d1);
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

  it("atomically removes account data and blocks an in-flight passkey registration from restoring the ID", async () => {
    const miniflare = new Miniflare({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      compatibilityDate: "2026-09-30",
      d1Databases: { ACCOUNT_DB: "account-deletion-test" },
    });
    instances.push(miniflare);
    const d1 = await miniflare.getD1Database("ACCOUNT_DB");
    await applyMigrations(d1);
    await d1.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES (?, ?, ?, 1, 1), (?, ?, ?, 1, 1)")
      .bind("deleted-user", "Synthetic Deleted", "deleted@example.test", "other-user", "Synthetic Other", "other@example.test").run();
    await d1.prepare("INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES ('s1',99,'token1',1,1,'deleted-user'),('s2',99,'token2',1,1,'other-user')").run();
    await d1.prepare("INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES ('a1','a1','passkey','deleted-user',1,1),('a2','a2','passkey','other-user',1,1)").run();
    await d1.prepare("INSERT INTO passkey(id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES ('p1','key1','deleted-user','credential1',0,'singleDevice',0),('p2','key2','other-user','credential2',0,'singleDevice',0)").run();
    await d1.prepare("INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES ('v1','deleted@example.test','verify1',99,1,1),('v2','other@example.test','verify2',99,1,1)").run();
    await d1.prepare("INSERT INTO account_invite(id,user_id,token_hash,created_at,expires_at) VALUES ('i1','deleted-user','hash1',1,99),('i2','other-user','hash2',1,99)").run();
    await d1.prepare("INSERT INTO account_entitlements(user_id,plan,monthly_ai_limit) VALUES ('deleted-user','free',10),('other-user','free',10)").run();
    await d1.prepare("INSERT INTO ai_usage(user_id,month,gemini_used,jev_used) VALUES ('deleted-user','2026-10',1,1),('other-user','2026-10',2,2)").run();
    await d1.prepare("INSERT INTO ai_receipt_flows(user_id,flow_id,month,created_at,image_mac,dispatched) VALUES ('deleted-user','flow1','2026-10',1,'mac1',1),('other-user','flow2','2026-10',1,'mac2',1)").run();
    await d1.prepare("INSERT INTO ai_provider_cost_events(id,user_id,provider,requested_model,model,metering_status,dispatched_at) VALUES ('e1','deleted-user','gemini','model','model','unknown',1),('e2','other-user','gemini','model','model','unknown',1)").run();
    await d1.prepare("INSERT INTO contact_submissions(user_id,flow_id,input_mac,state,updated_at) VALUES ('deleted-user','contact1','mac1','ready',1),('other-user','contact2','mac2','ready',1)").run();

    // Simulates completion of provider work that had already started when deletion began.
    await deleteAccountData(d1, "deleted-user");
    await deleteAccountData(d1, "deleted-user");

    const ownedRows: Array<[string, string, string, string]> = [
      ["session", "userId", "deleted-user", "other-user"], ["account", "userId", "deleted-user", "other-user"],
      ["passkey", "userId", "deleted-user", "other-user"], ["verification", "identifier", "deleted@example.test", "other@example.test"],
      ["account_invite", "user_id", "deleted-user", "other-user"], ["account_entitlements", "user_id", "deleted-user", "other-user"],
      ["ai_usage", "user_id", "deleted-user", "other-user"], ["ai_receipt_flows", "user_id", "deleted-user", "other-user"],
      ["ai_provider_cost_events", "user_id", "deleted-user", "other-user"], ["contact_submissions", "user_id", "deleted-user", "other-user"],
    ];
    for (const [table, ownerColumn, deletedOwner, otherOwner] of ownedRows) {
      const deleted = await d1.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerColumn}=?`).bind(deletedOwner).first<{ count: number }>();
      const other = await d1.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerColumn}=?`).bind(otherOwner).first<{ count: number }>();
      expect(deleted?.count, `${table} for deleted account`).toBe(0);
      expect(other?.count, `${table} for another account`).toBe(1);
    }
    expect((await d1.prepare("SELECT id FROM user WHERE id='deleted-user'").first())).toBeNull();
    expect((await d1.prepare("SELECT user_id FROM account_deletion_tombstones WHERE user_id='deleted-user'").first<{ user_id: string }>())?.user_id).toBe("deleted-user");
    expect((await d1.prepare("SELECT COUNT(*) AS count FROM session WHERE userId='other-user'").first<{ count: number }>())?.count).toBe(1);
    await expect(d1.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('deleted-user','Late','late@example.test',2,2)").run()).rejects.toThrow();
  });
});
