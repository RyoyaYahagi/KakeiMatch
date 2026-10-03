import { readdirSync, readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { handleAccountRequest, type AccountEnv } from "./account-auth";
import { consumeSignupTicket } from "./account-signup";
import { digest } from "./account-http";
import { acceptFamilyInvite, createFamilyInvite } from "./family-invites";

const origin = "http://localhost:8787";
const migrationSql = [
  "0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql",
  "0004_ai_provider_costs.sql", "0005_ai_global_guardrails.sql", "0006_contact_submissions.sql",
  "0007_account_deletion.sql", "0008_open_signup_family_invites.sql",
].map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .map(migration => migration.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim())
  .join("\n");
const bootstrapSecret = "operator-secret-for-d1-integration-test";
const now = Date.parse("2026-10-03T00:00:00Z");
const instances: Miniflare[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

async function database() {
  const miniflare = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    compatibilityDate: "2026-09-30",
    d1Databases: { ACCOUNT_DB: "family-invite-test" },
  });
  instances.push(miniflare);
  const d1 = await miniflare.getD1Database("ACCOUNT_DB");
  await d1.exec(migrationSql);
  for (const id of ["alice", "bob", "carol", "dave", "erin", "frank"]) {
    await d1.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES (?, ?, ?, 1, 1)")
      .bind(id, `Synthetic ${id}`, `${id}@example.test`).run();
  }
  return d1;
}

const session = (id: string) => ({ userId: id, email: `${id}@example.test` });
const options = { now: now + 1000, maxFamilyAccounts: 5 };
const planOf = async (d1: Awaited<ReturnType<typeof database>>, id: string) =>
  (await d1.prepare("SELECT plan FROM account_entitlements WHERE user_id = ?").bind(id).first<{ plan: string }>())?.plan ?? "free";

describe("Family invites with local D1", () => {
  it("issues a fragment URL with an operator secret and stores only digests", async () => {
    const d1 = await database();
    const env: AccountEnv = {
      ACCOUNT_DB: d1, BETTER_AUTH_SECRET: "better-auth-secret-for-d1-integration-test", ACCOUNT_BOOTSTRAP_SECRET: bootstrapSecret,
      CLOUD_ACCOUNT_ORIGIN: origin, ACCOUNT_RATE_LIMIT: { limit: async () => ({ success: true }) },
    };
    const response = await handleAccountRequest(new Request(`${origin}/api/account/family-invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${bootstrapSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ email: " Alice@Example.test " }),
    }), env);
    expect(response.status).toBe(201);
    const body = await response.json() as { inviteUrl: string; targetEmail: string };
    const token = new URL(body.inviteUrl).hash.replace("#family-invite=", "");
    expect(new URL(body.inviteUrl).search).toBe("");
    expect(body.targetEmail).toBe("alice@example.test");
    const row = await d1.prepare("SELECT token_hash, target_email_hash FROM family_invites").first<{ token_hash: string; target_email_hash: string }>();
    expect(row?.token_hash).toBe(await digest(token));
    expect(row?.target_email_hash).toBe(await digest("alice@example.test"));
    expect(JSON.stringify(row)).not.toContain("alice");

    expect(await acceptFamilyInvite(d1, session("alice"), token, { now: Date.now(), maxFamilyAccounts: 5 })).toEqual({ status: "granted" });
    expect(await planOf(d1, "alice")).toBe("family");
  });

  it("upgrades a newly signed-up account and an existing account, once per token", async () => {
    const d1 = await database();
    await d1.prepare(`INSERT INTO account_signup_tickets(id,user_id,token_hash,email,name,created_at,expires_at)
      VALUES ('ticket','new-member','ticket-hash','new@example.test','New',?,?)`).bind(now, now + 60_000).run();
    const newUserId = await consumeSignupTicket(d1, "ticket-hash", now + 1);
    expect(await planOf(d1, newUserId!)).toBe("free");
    const forNew = await createFamilyInvite(d1, "new@example.test", now);
    expect(await acceptFamilyInvite(d1, { userId: newUserId!, email: "new@example.test" }, forNew.token, options)).toEqual({ status: "granted" });
    expect(await planOf(d1, newUserId!)).toBe("family");

    const forExisting = await createFamilyInvite(d1, null, now);
    expect(await acceptFamilyInvite(d1, session("bob"), forExisting.token, options)).toEqual({ status: "granted" });
    // A lost response may be retried by the same user without granting anything else.
    expect(await acceptFamilyInvite(d1, session("bob"), forExisting.token, options)).toEqual({ status: "granted" });
    expect(await acceptFamilyInvite(d1, session("carol"), forExisting.token, options)).toEqual({ status: "invalid" });
    expect(await planOf(d1, "carol")).toBe("free");
  });

  it("rejects tampered, expired, and wrong-target tokens without changing the plan", async () => {
    const d1 = await database();
    const valid = await createFamilyInvite(d1, "alice@example.test", now);
    const tampered = `${valid.token.slice(0, -1)}${valid.token.endsWith("A") ? "B" : "A"}`;
    expect(await acceptFamilyInvite(d1, session("alice"), tampered, options)).toEqual({ status: "invalid" });
    expect(await acceptFamilyInvite(d1, session("alice"), "not-a-token", options)).toEqual({ status: "invalid" });
    expect(await acceptFamilyInvite(d1, session("bob"), valid.token, options)).toEqual({ status: "invalid" });
    expect(await acceptFamilyInvite(d1, session("alice"), valid.token, { ...options, now: valid.expiresAt })).toEqual({ status: "invalid" });
    expect(await planOf(d1, "alice")).toBe("free");
    expect(await planOf(d1, "bob")).toBe("free");
    expect(await d1.prepare("SELECT COUNT(*) AS count FROM family_invites WHERE used_at IS NOT NULL").first()).toEqual({ count: 0 });
  });

  it("lets at most one of many concurrent users consume the same token", async () => {
    const d1 = await database();
    const invite = await createFamilyInvite(d1, null, now);
    const users = ["alice", "bob", "carol", "dave"];
    const results = await Promise.all(users.map((id) => acceptFamilyInvite(d1, session(id), invite.token, options)));
    expect(results.filter((result) => result.status === "granted")).toHaveLength(1);
    const family = await d1.prepare("SELECT COUNT(*) AS count FROM account_entitlements WHERE plan = 'family'").first();
    expect(family).toEqual({ count: 1 });
  });

  it("enforces the Family account cap inside the consuming transaction", async () => {
    const d1 = await database();
    const invites = await Promise.all(["alice", "bob", "carol"].map(() => createFamilyInvite(d1, null, now)));
    const results = await Promise.all(["alice", "bob", "carol"].map((id, index) =>
      acceptFamilyInvite(d1, session(id), invites[index].token, { ...options, maxFamilyAccounts: 2 })));
    expect(results.filter((result) => result.status === "granted")).toHaveLength(2);
    expect(results.filter((result) => result.status === "limit_reached")).toHaveLength(1);
    const unused = await d1.prepare("SELECT COUNT(*) AS count FROM family_invites WHERE used_at IS NULL").first();
    expect(unused).toEqual({ count: 1 });
  });

  it("keeps an existing Family entitlement and does not spend a token on it", async () => {
    const d1 = await database();
    await d1.prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit) VALUES ('erin', 'family', NULL), ('frank', 'pro', 100)").run();
    const invite = await createFamilyInvite(d1, null, now);
    expect(await acceptFamilyInvite(d1, session("erin"), invite.token, options)).toEqual({ status: "already_family" });
    expect(await d1.prepare("SELECT used_at FROM family_invites").first()).toEqual({ used_at: null });
    expect(await planOf(d1, "frank")).toBe("pro");
  });

  it("does not let a deleted account's used token become reusable", async () => {
    const d1 = await database();
    const invite = await createFamilyInvite(d1, null, now);
    expect(await acceptFamilyInvite(d1, session("alice"), invite.token, options)).toEqual({ status: "granted" });
    await d1.prepare("DELETE FROM user WHERE id = 'alice'").run();
    expect(await acceptFamilyInvite(d1, session("bob"), invite.token, options)).toEqual({ status: "invalid" });
  });
});

describe("Family grant audit", () => {
  it("keeps entitlement writes in the Family invite module only", () => {
    const sourceDir = new URL("./", import.meta.url);
    const writers = readdirSync(sourceDir)
      .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
      .filter((name) => /(INSERT INTO|UPDATE|DELETE FROM)\s+account_entitlements/.test(readFileSync(new URL(name, sourceDir), "utf8")));
    // Plan changes are otherwise only the operator's `account:set-plan` command, outside the Worker.
    expect(writers).toEqual(["family-invites.ts"]);
  });
});
