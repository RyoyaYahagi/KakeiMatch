import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { importStatement, StatementImportError } from "@/lib/statement-import";
import type { StatementProvider } from "@/lib/statement-parser";

export const runtime = "nodejs";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024;
const providers = new Set<StatementProvider>(["smbc_card", "rakuten_card", "aeon_card", "paypay"]);
const csvTypes = new Set(["", "text/csv", "application/csv", "application/vnd.ms-excel", "application/octet-stream"]);

function privateJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function readBoundedBody(request: NextRequest): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request.headers);
  if (!user) return privateJson({ error: "ログインしてください。" }, 401);
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return privateJson({ error: "CSVファイルは5 MiB以下にしてください。" }, 413);
  }

  let form: FormData;
  try {
    const body = await readBoundedBody(request);
    if (!body) return privateJson({ error: "CSVファイルは5 MiB以下にしてください。" }, 413);
    form = await new Response(new Uint8Array(body), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return privateJson({ error: "CSVファイルを読み込めませんでした。" }, 400);
  }

  const provider = form.get("provider");
  const file = form.get("file");
  if (typeof provider !== "string" || !providers.has(provider as StatementProvider)) {
    return privateJson({ error: "決済サービスを選択してください。" }, 400);
  }
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv") || !csvTypes.has(file.type.toLowerCase())) {
    return privateJson({ error: "CSVファイルを選択してください。" }, 400);
  }
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    return privateJson({ error: "空でない5 MiB以下のCSVファイルを選択してください。" }, 400);
  }

  try {
    const summary = await importStatement({ userId: user.id, provider: provider as StatementProvider, bytes: Buffer.from(await file.arrayBuffer()) });
    return privateJson(summary, 201);
  } catch (error) {
    if (error instanceof StatementImportError) return privateJson({ error: error.message, issues: error.issues }, error.status);
    console.error("明細の保存に失敗しました。");
    return privateJson({ error: "明細を保存できませんでした。時間をおいて再試行してください。" }, 500);
  }
}
