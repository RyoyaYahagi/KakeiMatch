import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { afterEach, describe, expect, it } from "vitest";
import { deleteAccountData, handleAccountRequest, handleAuthRequest, type AccountEnv } from "./account-auth";
import type { SyncR2Bucket } from "./sync-storage-provider";

const origin = "http://localhost:8787";
const migrations = [
  "0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql",
  "0004_ai_provider_costs.sql", "0005_ai_global_guardrails.sql", "0006_contact_submissions.sql",
  "0007_account_deletion.sql", "0009_device_sync.sql", "0010_sync_storage_operations.sql",
].map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
const migrationSql = migrations
  .map(migration => migration.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").trim())
  .join("\n");
type MigrationDatabase = Pick<Awaited<ReturnType<Miniflare["getD1Database"]>>, "exec">;
const applyMigrations = (d1: MigrationDatabase) => d1.exec(migrationSql);
const authSecret = "better-auth-secret-for-d1-integration-test";
const bootstrapSecret = "operator-secret-for-d1-integration-test";
const instances: Miniflare[] = [];

function testBucket() {
  const objects = new Map<string, Uint8Array>();
  const deletedKeys: string[] = [];
  let nextDeleteFailure: string | null = null;
  const metadata = (key: string) => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    return {
      size: bytes.byteLength,
      checksums: { sha256: new Uint8Array(32).buffer },
    };
  };
  const bucket: SyncR2Bucket = {
    async put() { throw new Error("put_not_used_by_account_deletion_test"); },
    async head(key) { return metadata(key); },
    async get(key) {
      const info = metadata(key);
      const bytes = objects.get(key);
      if (!info || !bytes) return null;
      return {
        ...info,
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } }),
      };
    },
    async delete(key) {
      deletedKeys.push(key);
      if (nextDeleteFailure === key) {
        nextDeleteFailure = null;
        throw new Error("synthetic_r2_delete_failure");
      }
      objects.delete(key);
    },
  };
  return {
    bucket,
    keys: () => [...objects.keys()],
    deletedKeys,
    seed(key: string, value: Uint8Array) { objects.set(key, value.slice()); },
    failNextDelete(key: string) { nextDeleteFailure = key; },
  };
}

function sessionAuth(database: AccountEnv["ACCOUNT_DB"]) {
  return betterAuth({
    appName: "KakeiMatch",
    baseURL: origin,
    secret: authSecret,
    database: database as never,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: { httpOnly: true, secure: false, sameSite: "lax" },
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    plugins: [passkey({ rpID: "localhost", rpName: "KakeiMatch", origin }), testUtils()],
  });
}

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

  it("deletes only the authenticated owner's R2 data after pending and failed cleanup retries", async () => {
    const miniflare = new Miniflare({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      compatibilityDate: "2026-09-30",
      d1Databases: { ACCOUNT_DB: "account-r2-deletion-test" },
    });
    instances.push(miniflare);
    const d1 = await miniflare.getD1Database("ACCOUNT_DB");
    await applyMigrations(d1);

    // This test-only Better Auth instance uses the production D1, base URL,
    // secret, cookie policy, and Passkey plugin. Its helper creates a real
    // session row and signed cookie consumed by the production handler.
    const auth = sessionAuth(d1);
    const test = (await auth.$context).test;
    const alice = await test.saveUser(test.createUser({ email: "alice@example.test", name: "Alice" }));
    const bob = await test.saveUser(test.createUser({ email: "bob@example.test", name: "Bob" }));
    const login = await test.login({ userId: alice.id });
    const signedCookie = login.headers.get("cookie");
    expect(signedCookie).toBeTruthy();
    const r2 = testBucket();
    const env: AccountEnv = {
      ACCOUNT_DB: d1,
      BETTER_AUTH_SECRET: authSecret,
      CLOUD_ACCOUNT_ORIGIN: origin,
      SYNC_BUCKET: r2.bucket,
    };

    const aliceHousehold = "00000000-0000-4000-8000-000000000101";
    const bobHousehold = "00000000-0000-4000-8000-000000000102";
    const aliceVersion = "00000000-0000-4000-8000-000000000201";
    const bobVersion = "00000000-0000-4000-8000-000000000202";
    const aliceObject = `${aliceHousehold}/00000000-0000-4000-8000-000000000301/0`;
    const bobObject = `${bobHousehold}/00000000-0000-4000-8000-000000000302/0`;
    const aliceCiphertext = new TextEncoder().encode("synthetic encrypted object for Alice");
    const bobCiphertext = new TextEncoder().encode("synthetic encrypted object for Bob");
    const checksum = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    r2.seed(aliceObject, aliceCiphertext);
    r2.seed(bobObject, bobCiphertext);
    const now = Date.now();

    await d1.batch([
      d1.prepare(`INSERT INTO sync_households(id,owner_user_id,provider,generation,current_version_id,current_sequence,status,created_at,updated_at)
        VALUES (?,?,'kakeimatch-r2',1,?,1,'active',?,?)`).bind(aliceHousehold, alice.id, aliceVersion, now, now),
      d1.prepare(`INSERT INTO sync_households(id,owner_user_id,provider,generation,current_version_id,current_sequence,status,created_at,updated_at)
        VALUES (?,?,'kakeimatch-r2',1,?,1,'active',?,?)`).bind(bobHousehold, bob.id, bobVersion, now, now),
      d1.prepare(`INSERT INTO sync_versions(id,household_id,parent_version_id,generation,sequence,state,chunk_count,total_bytes,object_prefix,created_by_device_id,created_at,published_at,expires_at)
        VALUES (?, ?, NULL, 1, 1, 'published', 1, ?, ?, 'synthetic-device', ?, ?, ?)`)
        .bind(aliceVersion, aliceHousehold, aliceCiphertext.byteLength, "00000000-0000-4000-8000-000000000301", now, now, now + 60_000),
      d1.prepare(`INSERT INTO sync_versions(id,household_id,parent_version_id,generation,sequence,state,chunk_count,total_bytes,object_prefix,created_by_device_id,created_at,published_at,expires_at)
        VALUES (?, ?, NULL, 1, 1, 'published', 1, ?, ?, 'synthetic-device', ?, ?, ?)`)
        .bind(bobVersion, bobHousehold, bobCiphertext.byteLength, "00000000-0000-4000-8000-000000000302", now, now, now + 60_000),
      d1.prepare(`INSERT INTO sync_chunks(household_id,version_id,chunk_index,sha256,size_bytes,object_key,state,created_at)
        VALUES (?, ?, 0, ?, ?, ?, 'pending', ?)`)
        .bind(aliceHousehold, aliceVersion, await checksum(aliceCiphertext), aliceCiphertext.byteLength, aliceObject, now),
      d1.prepare(`INSERT INTO sync_chunks(household_id,version_id,chunk_index,sha256,size_bytes,object_key,state,created_at)
        VALUES (?, ?, 0, ?, ?, ?, 'stored', ?)`)
        .bind(bobHousehold, bobVersion, await checksum(bobCiphertext), bobCiphertext.byteLength, bobObject, now),
      d1.prepare(`INSERT INTO sync_storage_operations(id,household_id,object_key,state,created_at)
        VALUES ('00000000-0000-4000-8000-000000000401', ?, ?, 'pending', ?)`)
        .bind(aliceHousehold, aliceObject, now),
    ]);

    const deleteRequest = () => handleAccountRequest(new Request(`${origin}/api/account/delete`, {
      method: "DELETE",
      headers: { cookie: signedCookie ?? "", origin },
    }), env);

    const pending = await deleteRequest();
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({ error: "storage_operation_pending" });
    expect(await d1.prepare("SELECT id FROM user WHERE id = ?").bind(alice.id).first()).not.toBeNull();
    expect(r2.keys().sort()).toEqual([aliceObject, bobObject].sort());
    expect(r2.deletedKeys).toEqual([]);

    // Model the in-flight PUT finishing while deletion is pending: the object
    // is retired and queued atomically before its pending guard is released.
    await d1.batch([
      d1.prepare("UPDATE sync_storage_operations SET state='settled' WHERE id='00000000-0000-4000-8000-000000000401'"),
      d1.prepare("INSERT OR IGNORE INTO sync_object_deletions(object_key,household_id) VALUES (?, ?)").bind(aliceObject, aliceHousehold),
      d1.prepare("DELETE FROM sync_storage_operations WHERE id='00000000-0000-4000-8000-000000000401'"),
    ]);
    r2.failNextDelete(aliceObject);
    const failedCleanup = await deleteRequest();
    expect(failedCleanup.status).toBe(503);
    expect(await d1.prepare("SELECT id FROM user WHERE id = ?").bind(alice.id).first()).not.toBeNull();
    expect(await d1.prepare("SELECT id FROM user WHERE id = ?").bind(bob.id).first()).not.toBeNull();
    expect(r2.keys().sort()).toEqual([aliceObject, bobObject].sort());
    expect(r2.deletedKeys).toEqual([aliceObject]);

    const retried = await deleteRequest();
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ deleted: true, localHouseholdDataPreserved: true });
    expect(await d1.prepare("SELECT id FROM user WHERE id = ?").bind(alice.id).first()).toBeNull();
    expect(await d1.prepare("SELECT id FROM user WHERE id = ?").bind(bob.id).first()).not.toBeNull();
    expect(r2.keys()).toEqual([bobObject]);
    expect(r2.deletedKeys).toEqual([aliceObject, aliceObject]);
    expect(await d1.prepare("SELECT id FROM sync_households WHERE owner_user_id = ?").bind(bob.id).first()).not.toBeNull();
    expect(await d1.prepare("SELECT id FROM sync_households WHERE owner_user_id = ?").bind(alice.id).first()).toBeNull();
  });
});
