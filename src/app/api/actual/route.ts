import { NextRequest, NextResponse } from "next/server";
import {
  ActualBudgetNotLinkedError,
  ActualUnavailableError,
  actualGateway,
} from "@/lib/actual-gateway";
import { getCurrentUser } from "@/lib/current-user";

export const runtime = "nodejs";

function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** Read-only data endpoint for the authenticated user's mapped budget. */
export async function GET(request: NextRequest) {
  if (!(await getCurrentUser(request.headers))) {
    return privateJson({ error: "authentication_required" }, 401);
  }

  const params = request.nextUrl.searchParams;
  try {
    switch (params.get("view")) {
      case "recent": {
        const limit = params.has("limit") ? Number(params.get("limit")) : undefined;
        return privateJson(await actualGateway.getRecentTransactions({ limit }));
      }
      case "range":
        return privateJson(
          await actualGateway.getTransactions({
            startDate: params.get("startDate") ?? "",
            endDate: params.get("endDate") ?? "",
          }),
        );
      case "monthly":
        return privateJson({ spendingYen: await actualGateway.getMonthlySpending({ yearMonth: params.get("yearMonth") ?? "" }) });
      default:
        return privateJson({ error: "invalid_request" }, 400);
    }
  } catch (error) {
    if (error instanceof ActualBudgetNotLinkedError) {
      return privateJson({ error: "budget_not_linked" }, 409);
    }
    if (error instanceof ActualUnavailableError) {
      return privateJson({ error: "actual_unavailable" }, 503);
    }
    return privateJson({ error: "invalid_request" }, 400);
  }
}
