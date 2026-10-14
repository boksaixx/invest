// 빠른 판단 API — 삼성전자·SK하이닉스 2종목. AI 호출 없이 2~4초 안에 "지금 할 일"을 돌려준다.
// 계산은 lib/quickCore.ts (AI 심층 분석 /api/deep 도 같은 계산 위에서 돈다).
import { NextResponse } from "next/server";
import { buildQuick, normalizePortfolio } from "@/lib/quickCore";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { portfolio?: unknown } | null;
    const { result } = await buildQuick(normalizePortfolio(body?.portfolio));
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: `분석 중 오류가 났어요: ${String(e).slice(0, 200)}` }, { status: 500 });
  }
}
