// GitHub Actions 자동 수집 데이터(30분 간격) 조회
import { NextResponse } from "next/server";
import { fetchLatestSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await fetchLatestSnapshot();
  return NextResponse.json({ snapshot });
}
