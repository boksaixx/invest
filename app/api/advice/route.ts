// AI 정밀 분석: 시세/지표(일봉+장중) 수집 → 뉴스 수집(Gemini) → 룰 엔진 → Claude 최종 판단
import { NextResponse } from "next/server";
import { getMacroSnapshot, getStockCandles, getStockIntradayCandles, getStockQuote } from "@/lib/market";
import { collectNews } from "@/lib/gemini";
import { computeRelativeStrength, computeSectorConcentration, runEngine } from "@/lib/engine";
import { computeIntradayInsight } from "@/lib/intraday";
import { getMarketPhase } from "@/lib/marketPhase";
import { generateAdvice } from "@/lib/claude";
import type { EngineSignal, Portfolio } from "@/lib/types";
import { TICKER_LIST } from "@/lib/types";
import { fetchLatestSnapshot } from "@/lib/snapshot";
import eventsData from "@/data/events.json";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { portfolio?: Portfolio };
    const portfolio: Portfolio = body.portfolio ?? { cash: 20_000_000, holdings: [] };

    const [macro, newsResult, snapshot, ...stockData] = await Promise.all([
      getMacroSnapshot(),
      collectNews(),
      fetchLatestSnapshot(),
      ...TICKER_LIST.map(async (t) => {
        const quote = await getStockQuote(t);
        const [candles, rawIntraday] = await Promise.all([getStockCandles(t), getStockIntradayCandles(t)]);
        return { ticker: t, quote, candles, rawIntraday };
      }),
    ]);
    const { news, error: newsError } = newsResult;
    const marketPhase = getMarketPhase();

    // 실시간 뉴스 수집 실패 시 자동수집 스냅샷의 뉴스로 폴백
    const effectiveNews = news.length > 0 ? news : (snapshot?.news ?? []);

    // 상대강도 랭킹 (시세 확보된 종목 기준)
    const withQuote = stockData.filter((sd): sd is typeof sd & { quote: NonNullable<typeof sd.quote> } => sd.quote != null);
    const rs = computeRelativeStrength(withQuote.map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })));

    // 섹터 집중도 (5종목 모두 반도체 — 분산투자 착시 방지)
    const quotesMap = Object.fromEntries(stockData.map((sd) => [sd.ticker, sd.quote]));
    const holdingsValue = portfolio.holdings.reduce((a, h) => a + h.qty * (quotesMap[h.ticker]?.price ?? h.avgPrice), 0);
    const totalAsset = portfolio.cash + holdingsValue;
    const concentration = computeSectorConcentration(portfolio.holdings, quotesMap, totalAsset);

    const signals: EngineSignal[] = [];
    for (const sd of stockData) {
      if (!sd.quote || sd.candles.length < 60) continue;
      const intraday = computeIntradayInsight(sd.rawIntraday, sd.quote.prevClose, sd.quote.price);
      signals.push(
        runEngine({
          ticker: sd.ticker,
          price: sd.quote.price,
          candles: sd.candles,
          macro,
          news: effectiveNews,
          portfolio,
          intraday,
          marketPhase,
          relativeStrengthNote: rs.noteFor(sd.ticker),
        }),
      );
    }

    if (signals.length === 0) {
      return NextResponse.json({ error: "시세 데이터를 가져오지 못했습니다. 잠시 후 다시 시도해주세요." }, { status: 502 });
    }

    const { advice, error: adviceError } = await generateAdvice({
      signals,
      macro,
      news: effectiveNews,
      portfolio,
      history: snapshot,
      events: eventsData.events,
      relativeStrengthSummary: rs.summary,
      sectorConcentrationWarning: concentration.warning,
    });

    return NextResponse.json({
      signals,
      advice,
      adviceError,
      news: effectiveNews,
      newsError: news.length === 0 ? newsError : null,
      macro,
      marketPhase,
      relativeStrengthSummary: rs.summary,
      sectorConcentrationWarning: concentration.warning,
      aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
      newsLive: news.length > 0,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
