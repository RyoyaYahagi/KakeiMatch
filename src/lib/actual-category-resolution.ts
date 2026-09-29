import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { actualCategoryMapping } from "@/db/schema";
import { CATEGORY_LABELS, type CategoryId } from "@/lib/category";

export class ActualCategorySetupRequiredError extends Error {
  constructor() {
    super("Actual category mapping is required.");
    this.name = "ActualCategorySetupRequiredError";
  }
}

export type ActualExpenseCategory = { id: string; name: string };

export function exactCategoryMatch(categoryId: CategoryId, categories: ActualExpenseCategory[]): string {
  const matches = categories.filter((category) => category.name === CATEGORY_LABELS[categoryId]);
  if (matches.length !== 1) throw new ActualCategorySetupRequiredError();
  return matches[0].id;
}

/** Resolve a confirmed KakeiMatch category to a category in this user's Budget. */
export async function resolveActualCategory(input: {
  userId: string;
  categoryId: CategoryId;
  categories: ActualExpenseCategory[];
}): Promise<string> {
  const [stored] = await db.select({ actualCategoryId: actualCategoryMapping.actualCategoryId })
    .from(actualCategoryMapping)
    .where(and(eq(actualCategoryMapping.userId, input.userId), eq(actualCategoryMapping.categoryId, input.categoryId)))
    .limit(1);
  if (stored) {
    if (input.categories.some((category) => category.id === stored.actualCategoryId)) return stored.actualCategoryId;
    throw new ActualCategorySetupRequiredError();
  }

  const matchedId = exactCategoryMatch(input.categoryId, input.categories);
  const now = new Date();
  await db.insert(actualCategoryMapping).values({
    id: randomUUID(),
    userId: input.userId,
    categoryId: input.categoryId,
    actualCategoryId: matchedId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  // A concurrent administrator may have saved a different mapping. Re-read the authoritative row.
  const [saved] = await db.select({ actualCategoryId: actualCategoryMapping.actualCategoryId })
    .from(actualCategoryMapping)
    .where(and(eq(actualCategoryMapping.userId, input.userId), eq(actualCategoryMapping.categoryId, input.categoryId)))
    .limit(1);
  if (!saved || !input.categories.some((category) => category.id === saved.actualCategoryId)) {
    throw new ActualCategorySetupRequiredError();
  }
  return saved.actualCategoryId;
}
