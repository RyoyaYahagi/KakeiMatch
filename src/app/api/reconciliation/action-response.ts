import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/current-user";
import { ReconciliationActionError } from "@/lib/reconciliation-review-actions";

const id = z.string().min(1).max(128);
export const pairActionSchema = z.object({ runId: id, statementTransactionId: id, receiptId: id });
export const noReceiptActionSchema = z.object({ runId: id, statementTransactionId: id, categoryId: id, actualAccountId: id });
export const retryActionSchema = z.object({ runId: id });

export async function handleReconciliationAction<T extends z.ZodObject<z.ZodRawShape>>(
  request: NextRequest, schema: T, action: (input: z.infer<T> & { userId: string }) => Promise<unknown>,
) {
  const user = await getCurrentUser(request.headers);
  if (!user) return json({ code: "unauthenticated", error: "ログインしてください。" }, 401);
  let input: z.infer<T>;
  try { input = schema.parse(await request.json()); }
  catch { return json({ code: "invalid_input", error: "入力内容を確認してください。" }, 400); }
  try { return json(await action({ ...input, userId: user.id })); }
  catch (error) {
    if (error instanceof ReconciliationActionError) return json({ code: error.code, error: error.message }, error.status);
    console.error("照合の判断を処理できませんでした。");
    return json({ code: "action_unavailable", error: "判断を処理できませんでした。もう一度お試しください。" }, 503);
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
