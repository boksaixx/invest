// GitHub Actions 자동 수집 데이터(30분 간격) 조회
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const repo = process.env.GITHUB_REPO || "boksaixx/invest";
  const branch = process.env.GITHUB_DATA_BRANCH || "main";
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/data/latest.json`, {
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ snapshot: null });
    const snapshot = await res.json();
    return NextResponse.json({ snapshot });
  } catch {
    return NextResponse.json({ snapshot: null });
  }
}
