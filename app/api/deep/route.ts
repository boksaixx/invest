// AI 심층 분석 API — 빠른 판단(lib/quickCore.ts)을 그대로 다시 계산한 뒤, 그 숫자를 전부 Claude에게 넘겨
// 시황 → 추세 → 수급 → 뉴스 → 결론 → 시나리오로 정리한다 (lib/deepAnalysis.ts, 가드레일 포함).
// 같은 자산·같은 5분 안의 반복 요청은 서버 메모리에 잠깐 캐시해 비용을 아낀다(인스턴스가 바뀌면 다시 계산).
import { NextResponse } from "next/server";
import { buildQuick, normalizePortfolio } from "@/lib/quickCore";
import { runDeepAnalysis, type DeepAnalysis } from "@/lib/deepAnalysis";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const cache = new Map<string, { at: number; analysis: DeepAnalysis }>();
const TTL = 5 * 60_000;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { portfolio?: unknown; force?: boolean } | null;
    const portfolio = normalizePortfolio(body?.portfolio);
    const key = JSON.stringify([portfolio.cash, portfolio.holdings]) + Math.floor(Date.now() / TTL);
    const hit = cache.get(key);
    if (hit && !body?.force && Date.now() - hit.at < TTL) return NextResponse.json({ analysis: hit.analysis, cached: true });

    const { result, ctx } = await buildQuick(portfolio);
    const { analysis, error, usage } = await runDeepAnalysis(ctx);
    if (analysis) {
      cache.set(key, { at: Date.now(), analysis });
      for (const [k, v] of cache) if (Date.now() - v.at > TTL) cache.delete(k);
    }
    return NextResponse.json(
      { analysis, error, usage: usage ? { costUsd: Math.round(usage.costUsd * 10000) / 10000, model: usage.model } : null, quick: result },
      { status: analysis ? 200 : 502 },
    );
  } catch (e) {
    return NextResponse.json({ error: `AI 분석 중 오류가 났어요: ${String(e).slice(0, 200)}` }, { status: 500 });
  }
}
