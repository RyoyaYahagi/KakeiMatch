import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { receipt } from "@/db/schema";
import { createActualReceiptWriterForUser } from "@/lib/actual-receipt-writer";
import { getCurrentUser } from "@/lib/current-user";
import { getLastUsedActualAccountId, getReceiptRegistrationDraft } from "@/lib/receipt-registration-state";

export const runtime = "nodejs";

function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** Return final values and current open account options only to the owner. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const owner = await getCurrentUser(request.headers);
  if (!owner) return privateJson({ error: "ログインしてください。" }, 401);
  const { id } = await context.params;
  const [owned] = await db.select({ id: receipt.id }).from(receipt)
    .where(and(eq(receipt.id, id), eq(receipt.ownerUserId, owner.id))).limit(1);
  if (!owned) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });

  try {
    const [draft, preference, accounts] = await Promise.all([
      getReceiptRegistrationDraft(owner.id, id),
      getLastUsedActualAccountId(owner.id),
      (await createActualReceiptWriterForUser(owner.id)).listOpenAccounts(),
    ]);
    const preferredAccountId = accounts.some((account) => account.id === preference) ? preference : null;
    return privateJson({
      draft: draft ? {
        merchant: draft.merchant, purchasedDate: draft.purchasedDate,
        totalAmountYen: draft.totalAmountYen, actualAccountId: draft.actualAccountId,
        status: draft.status, registeredAt: draft.registeredAt,
        editable: draft.status !== "registering" && !(draft.status === "failed" && draft.lastErrorCode === "actual_write_uncertain"),
      } : null,
      accounts,
      preferredAccountId,
    });
  } catch {
    // A Budget outage must not hide already saved corrections.
    const draft = await getReceiptRegistrationDraft(owner.id, id);
    return privateJson({
      draft: draft ? {
        merchant: draft.merchant, purchasedDate: draft.purchasedDate,
        totalAmountYen: draft.totalAmountYen, actualAccountId: draft.actualAccountId,
        status: draft.status, registeredAt: draft.registeredAt,
        editable: draft.status !== "registering" && !(draft.status === "failed" && draft.lastErrorCode === "actual_write_uncertain"),
      } : null,
      accounts: [], preferredAccountId: null, accountError: true,
    });
  }
}
