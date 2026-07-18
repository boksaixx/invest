// AI 정밀 분석: 시세/지표 수집 → 뉴스 수집(Gemini) → 룰 엔진 → Claude 최종 판단
import { NextResponse } from "next/server";
import { getMacroSnapshot, getStockCandles, getStockQuote } from "@/lib/market";
import { collectNews } from "@/lib/gemini";
import { runEngine } from "@/lib/engine";
import { generateAdvice } from "@/lib/claude";
import type { EngineSignal, Portfolio, StockTicker } from "@/lib/types";
import { fetchLatestSnapshot } from "@/lib/snapshot";
import eventsData from "@/data/events.json";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TICKERS: StockTicker[] = ["005930", "000660"];

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { portfolio?: Portfolio };
    const portfolio: Portfolio = body.portfolio ?? { cash: 20_000_000, holdings: [] };

    const [macro, news, snapshot, ...stockData] = await Promise.all([
      getMacroSnapshot(),
      collectNews(),
      fetchLatestSnapshot(),
      ...TICKERS.map(async (t) => ({
        ticker: t,
        quote: await getStockQuote(t),
        candles: await getStockCandles(t),
      })),
    ]);

    // 실시간 뉴스 수집 실패 시 자동수집 스냅샷의 뉴스로 폴백
    const effectiveNews = news.length > 0 ? news : (snapshot?.news ?? []);

    const signals: EngineSignal[] = [];
    for (const sd of stockData) {
      if (!sd.quote || sd.candles.length < 60) continue;
      signals.push(
        runEngine({
          ticker: sd.ticker,
          price: sd.quote.price,
          candles: sd.candles,
          macro,
          news: effectiveNews,
          portfolio,
        }),
      );
    }

    if (signals.length === 0) {
      return NextResponse.json({ error: "시세 데이터를 가져오지 못했습니다. 잠시 후 다시 시도해주세요." }, { status: 502 });
    }

    const advice = await generateAdvice({
      signals,
      macro,
      news: effectiveNews,
      portfolio,
      history: snapshot,
      events: eventsData.events,
    });

    return NextResponse.json({
      signals,
      advice,
      news: effectiveNews,
      macro,
      aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
      newsLive: news.length > 0,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
