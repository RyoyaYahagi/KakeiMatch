import { spawnSync } from "node:child_process";

const [userId, plan] = process.argv.slice(2);
const dbId = process.env.ACCOUNT_D1_ID;
if (!dbId || !/^[0-9a-f-]{36}$/i.test(dbId)) {
  console.error("Set ACCOUNT_D1_ID to the account D1 database UUID.");
  process.exit(2);
}
if (!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId) || !["free", "pro", "family"].includes(plan)) {
  console.error("Usage: npm run account:set-plan -- <opaque-user-id> <free|pro|family>");
  process.exit(2);
}
// free は付与を消して「付与なし」と同じ日次上限にする（free の月間上限は読まれない）。
// pro の上限 0 は利用停止（有効な StoreKit 購入があれば購入が優先される）。family は上限なし。
let sql;
if (plan === "free") {
  sql = `DELETE FROM account_entitlements WHERE user_id = '${userId}'`;
} else {
  let limit = "NULL";
  if (plan === "pro") {
    const configured = process.env.AI_PRO_MONTHLY_LIMIT ?? "";
    if (!/^(0|[1-9][0-9]*)$/.test(configured) || !Number.isSafeInteger(Number(configured))) {
      console.error("Set AI_PRO_MONTHLY_LIMIT to a non-negative integer for pro assignments. 0 stops the account (0/month) unless it has a valid StoreKit purchase.");
      process.exit(2);
    }
    limit = configured;
  }
  sql = `INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit, updated_at) VALUES ('${userId}', '${plan}', ${limit}, unixepoch()) ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, monthly_ai_limit = excluded.monthly_ai_limit, updated_at = excluded.updated_at`;
}
const result = spawnSync("cf", ["d1", "query", dbId, "--sql", sql], { stdio: "inherit" });
if (result.error) {
  console.error("Could not run cf d1 query. Check that the cf CLI is installed and authenticated.");
  process.exit(1);
}
process.exit(result.status ?? 1);
