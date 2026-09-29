import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { runReconciliation } from "@/lib/reconciliation-service";
import { applyAutomaticMatches } from "@/lib/reconciliation-review-actions";

export const runtime = "nodejs";

function privateJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** Run for the authenticated owner only; request data cannot select another owner. */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request.headers);
  if (!user) return privateJson({ code: "unauthenticated", error: "ログインしてください。" }, 401);
  try {
    const result = await runReconciliation(user.id);
    await applyAutomaticMatches(user.id, result.runId);
    return privateJson(result, 201);
  } catch {
    console.error("照合を実行できませんでした。");
    return privateJson({ code: "reconciliation_failed", error: "照合を実行できませんでした。時間をおいて再試行してください。" }, 500);
  }
}
