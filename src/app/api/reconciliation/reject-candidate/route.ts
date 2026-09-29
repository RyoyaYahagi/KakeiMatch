import { NextRequest } from "next/server";
import { handleReconciliationAction, pairActionSchema } from "@/app/api/reconciliation/action-response";
import { rejectCandidate } from "@/lib/reconciliation-review-actions";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  return handleReconciliationAction(request, pairActionSchema, rejectCandidate);
}
