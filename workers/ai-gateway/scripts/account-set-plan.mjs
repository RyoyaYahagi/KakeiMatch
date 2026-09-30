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
let limit = "NULL";
if (plan !== "family") {
  const variable = plan === "free" ? "AI_FREE_MONTHLY_LIMIT" : "AI_PRO_MONTHLY_LIMIT";
  const configured = process.env[variable];
  const number = Number(configured);
  if (!configured || !Number.isSafeInteger(number) || number < 1) {
    console.error(`Set ${variable} to a positive integer for ${plan} assignments.`);
    process.exit(2);
  }
  limit = String(number);
}
const sql = `INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit, updated_at) VALUES ('${userId}', '${plan}', ${limit}, unixepoch()) ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, monthly_ai_limit = excluded.monthly_ai_limit, updated_at = excluded.updated_at`;
const result = spawnSync("cf", ["d1", "query", dbId, "--sql", sql], { stdio: "inherit" });
if (result.error) {
  console.error("Could not run cf d1 query. Check that the cf CLI is installed and authenticated.");
  process.exit(1);
}
process.exit(result.status ?? 1);
