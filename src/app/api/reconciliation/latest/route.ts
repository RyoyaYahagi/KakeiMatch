import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { getLatestReconciliation } from "@/lib/reconciliation-service";

export const runtime = "nodejs";

function privateJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** Return the latest completed snapshot belonging to the authenticated owner. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request.headers);
  if (!user) return privateJson({ code: "unauthenticated", error: "ログインしてください。" }, 401);
  try {
    return privateJson(await getLatestReconciliation(user.id));
  } catch {
    console.error("照合結果を取得できませんでした。");
    return privateJson({ code: "reconciliation_unavailable", error: "照合結果を取得できませんでした。時間をおいて再試行してください。" }, 500);
  }
}
