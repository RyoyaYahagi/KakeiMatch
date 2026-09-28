import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { receipt } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { receiptStorage } from "@/lib/receipt-storage";

export const runtime = "nodejs";

function notFound() {
  return new NextResponse(null, {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/** Return an image only after finding its metadata within the session owner's scope. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const owner = await getCurrentUser(request.headers);
  if (!owner) return new NextResponse(null, { status: 401, headers: { "Cache-Control": "private, no-store" } });

  const { id } = await context.params;
  let metadata: { storageKey: string; contentType: string } | undefined;
  try {
    [metadata] = await db
      .select({ storageKey: receipt.storageKey, contentType: receipt.contentType })
      .from(receipt)
      .where(and(eq(receipt.id, id), eq(receipt.ownerUserId, owner.id)))
      .limit(1);
  } catch {
    return new NextResponse(null, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }

  if (!metadata) return notFound();
  try {
    const bytes = await receiptStorage.get(metadata.storageKey);
    if (!bytes) return notFound();
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": metadata.contentType,
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse(null, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
