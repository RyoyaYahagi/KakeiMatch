import { NextRequest, NextResponse } from "next/server";
import { handleReconciliationAction, retryActionSchema } from "@/app/api/reconciliation/action-response";
import { retryResolution } from "@/lib/reconciliation-review-actions";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id || id.length > 128) return NextResponse.json({ code: "not_found", error: "判断記録が見つかりません。" }, { status: 404 });
  return handleReconciliationAction(request, retryActionSchema, (input) => retryResolution({ ...input, resolutionId: id }));
}
