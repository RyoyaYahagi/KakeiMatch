import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { receipt } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { receiptStorage } from "@/lib/receipt-storage";
import { MAX_RECEIPT_SIZE_BYTES, ReceiptValidationError, validateReceiptImage } from "@/lib/receipt-validation";

export const runtime = "nodejs";
const MAX_MULTIPART_BODY_BYTES = MAX_RECEIPT_SIZE_BYTES + 64 * 1024;

function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function readBoundedBody(request: NextRequest): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MULTIPART_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

/** Save a receipt image for the user identified by the Better Auth session. */
export async function POST(request: NextRequest) {
  const owner = await getCurrentUser(request.headers);
  if (!owner) return privateJson({ error: "ログインしてください。" }, 401);

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BODY_BYTES) {
    return privateJson({ error: "画像のサイズは10 MiB以下にしてください。" }, 413);
  }

  let form: FormData;
  try {
    const body = await readBoundedBody(request);
    if (!body) return privateJson({ error: "画像のサイズは10 MiB以下にしてください。" }, 413);
    form = await new Response(new Uint8Array(body), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return privateJson({ error: "画像を読み込めませんでした。画像を選び直してください。" }, 400);
  }
  const file = form.get("image");
  if (!(file instanceof File)) {
    return privateJson({ error: "画像ファイルを選択してください。" }, 400);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
    const validated = validateReceiptImage({ bytes, declaredContentType: file.type });
    const { storageKey } = await receiptStorage.put({ bytes, contentType: validated.contentType });
    const id = randomUUID();
    const createdAt = new Date();
    try {
      await db.insert(receipt).values({
        id,
        ownerUserId: owner.id,
        storageKey,
        contentType: validated.contentType,
        fileSize: validated.sizeBytes,
        createdAt,
      });
    } catch {
      try {
        await receiptStorage.delete(storageKey);
      } catch {
        console.error("レシート画像の後始末に失敗しました。");
      }
      return privateJson({ error: "レシートを保存できませんでした。時間をおいてもう一度お試しください。" }, 500);
    }

    return privateJson({
      id,
      contentType: validated.contentType,
      fileSize: validated.sizeBytes,
      createdAt: createdAt.toISOString(),
    }, 201);
  } catch (error) {
    if (error instanceof ReceiptValidationError) return privateJson({ error: error.message }, 400);
    return privateJson({ error: "レシートを保存できませんでした。時間をおいてもう一度お試しください。" }, 500);
  }
}
