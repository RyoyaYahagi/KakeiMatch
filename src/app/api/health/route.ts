import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export const runtime = "nodejs";

export function GET() {
  db.run(sql`SELECT 1`);
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
