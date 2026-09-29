import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("An interactive terminal is required.");
  loadEnvConfig(process.cwd());
  const [{ db }, { user, actualBudgetMapping, actualCategoryMapping }, { CATEGORY_IDS, CATEGORY_LABELS }, { createActualReceiptWriterForUser }, { and, eq }] = await Promise.all([
    import("@/db/client"), import("@/db/schema"), import("@/lib/category"), import("@/lib/actual-receipt-writer"), import("drizzle-orm"),
  ]);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const email = (await prompt.question("KakeiMatch user email: ")).trim().toLowerCase();
    const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    if (!owner) throw new Error("User not found.");
    const [budget] = await db.select({ id: actualBudgetMapping.id }).from(actualBudgetMapping)
      .where(eq(actualBudgetMapping.userId, owner.id)).limit(1);
    if (!budget) throw new Error("This user has no linked Budget.");

    const categories = await createActualReceiptWriterForUser(owner.id).listExpenseCategories();
    if (categories.length === 0) throw new Error("No available expense categories were found.");
    stdout.write("Available expense categories:\n");
    categories.forEach((category, index) => stdout.write(`${index + 1}. ${category.name}\n`));

    for (const categoryId of CATEGORY_IDS) {
      const [existing] = await db.select().from(actualCategoryMapping).where(and(
        eq(actualCategoryMapping.userId, owner.id), eq(actualCategoryMapping.categoryId, categoryId),
      )).limit(1);
      const current = categories.find((category) => category.id === existing?.actualCategoryId)?.name ?? (existing ? "unavailable" : "none");
      const answer = (await prompt.question(`${CATEGORY_LABELS[categoryId]} (current: ${current}; number or Enter to keep): `)).trim();
      if (!answer) continue;
      const choice = Number(answer);
      if (!Number.isInteger(choice) || choice < 1 || choice > categories.length) {
        stdout.write("Invalid selection. No change saved.\n");
        continue;
      }
      const selected = categories[choice - 1];
      if (existing && existing.actualCategoryId !== selected.id) {
        const confirmation = (await prompt.question(`Replace existing mapping for ${CATEGORY_LABELS[categoryId]}? Type YES: `)).trim();
        if (confirmation !== "YES") continue;
      }
      const now = new Date();
      await db.insert(actualCategoryMapping).values({
        id: randomUUID(), userId: owner.id, categoryId, actualCategoryId: selected.id,
        createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: [actualCategoryMapping.userId, actualCategoryMapping.categoryId],
        set: { actualCategoryId: selected.id, updatedAt: now },
      });
      stdout.write(`Saved: ${CATEGORY_LABELS[categoryId]} -> ${selected.name}\n`);
    }
  } finally {
    prompt.close();
  }
}

main().catch(() => {
  // Do not print raw Actual errors; administrative stdout should not contain credentials or receipt data.
  console.error("Unable to configure category mappings. Check the selected user and Actual connection.");
  process.exitCode = 1;
});
