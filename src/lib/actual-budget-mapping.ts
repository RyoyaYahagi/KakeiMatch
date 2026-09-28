import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { actualBudgetMapping, user } from "@/db/schema";

function isSqliteConstraintError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

/** Link one existing KakeiMatch user to one Actual Budget Sync ID. */
export async function linkActualBudget(email: string, syncId: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedSyncId = syncId.trim();
  if (!normalizedEmail || !normalizedSyncId) {
    throw new Error("Email and Sync ID are required.");
  }

  await db.transaction((tx) => {
    const [account] = tx.select({ id: user.id }).from(user).where(eq(user.email, normalizedEmail)).limit(1).all();
    if (!account) throw new Error("No KakeiMatch user exists with that email address.");

    const [userMapping] = tx
      .select({ id: actualBudgetMapping.id })
      .from(actualBudgetMapping)
      .where(eq(actualBudgetMapping.userId, account.id))
      .limit(1)
      .all();
    if (userMapping) throw new Error("A mapping already exists for this user.");

    const [syncMapping] = tx
      .select({ id: actualBudgetMapping.id })
      .from(actualBudgetMapping)
      .where(eq(actualBudgetMapping.syncId, normalizedSyncId))
      .limit(1)
      .all();
    if (syncMapping) throw new Error("This Sync ID is already assigned to another user.");

    const now = new Date();
    try {
      tx.insert(actualBudgetMapping)
        .values({
          id: randomUUID(),
          userId: account.id,
          syncId: normalizedSyncId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (error) {
      // Unique constraints remain authoritative if two admins link at the same time.
      if (isSqliteConstraintError(error)) {
        throw new Error("Unable to create the mapping because a conflicting mapping already exists.");
      }
      throw error;
    }
  });
}
