import { NextRequest } from "next/server";
import { handleReconciliationAction, noReceiptActionSchema } from "@/app/api/reconciliation/action-response";
import { confirmNoReceipt } from "@/lib/reconciliation-review-actions";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  return handleReconciliationAction(request, noReceiptActionSchema, confirmNoReceipt);
}
