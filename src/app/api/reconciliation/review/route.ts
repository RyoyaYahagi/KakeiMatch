import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { getReconciliationReview } from "@/lib/reconciliation-review";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request.headers);
  if (!user) return NextResponse.json({ code: "unauthenticated", error: "ログインしてください。" }, { status: 401 });
  try {
    return NextResponse.json(await getReconciliationReview(user.id), { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ code: "review_unavailable", error: "照合結果を取得できませんでした。" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
