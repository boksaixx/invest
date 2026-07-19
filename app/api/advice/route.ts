// AI 정밀 분석: 시세/지표(일봉+장중) 수집 → 뉴스 수집(Gemini) → 룰 엔진 → Claude 최종 판단
import { NextResponse } from "next/server";
import { getMacroSnapshot, getStockCandles, getStockIntradayCandles, getStockQuote } from "@/lib/market";
import { collectNews } from "@/lib/gemini";
import { fetchDartDisclosures } from "@/lib/dart";
import { computeMasterScore, computeRelativeStrength, computeSectorConcentration, runEngine } from "@/lib/engine";
import { computeIntradayInsight } from "@/lib/intraday";
import { getMarketPhase } from "@/lib/marketPhase";
import { generateAdvice } from "@/lib/claude";
import type { EngineSignal, NewsItem, Portfolio } from "@/lib/types";
import { TICKER_LIST } from "@/lib/types";
import { fetchLatestSnapshot } from "@/lib/snapshot";
import { fetchBacktestSnapshot } from "@/lib/backtest";
import eventsData from "@/data/events.json";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { portfolio?: Portfolio };
    const portfolio: Portfolio = body.portfolio ?? { cash: 20_000_000, holdings: [] };

    const [macro, snapshot, backtest, disclosureResult, ...stockData] = await Promise.all([
      getMacroSnapshot(),
      fetchLatestSnapshot(),
      fetchBacktestSnapshot(),
      fetchDartDisclosures(),
      ...TICKER_LIST.map(async (t) => {
        const quote = await getStockQuote(t);
        const [candles, rawIntraday] = await Promise.all([getStockCandles(t), getStockIntradayCandles(t)]);
        return { ticker: t, quote, candles, rawIntraday };
      }),
    ]);
    const marketPhase = getMarketPhase();

    // 뉴스 수집·분석 분리: 크론이 15분 간격으로 이미 Gemini를 호출해 data/latest.json에 저장해두므로,
    // 그 캐시가 충분히 신선하면 그대로 재사용하고, 없거나 오래됐을 때만 라이브로 다시 호출한다.
    // Gemini 그라운딩 호출은 사용자 클릭마다 중복으로 쏘면 그만큼 과금이 배가되므로 여기서 아낀다.
    const NEWS_CACHE_FRESH_MS = 20 * 60_000; // 자동수집 간격(15분)보다 여유를 둔 신선도 기준
    const snapshotAgeMs = snapshot?.collectedAt ? Date.now() - new Date(snapshot.collectedAt).getTime() : Infinity;
    const cacheIsFresh = Boolean(snapshot) && (snapshot?.news.length ?? 0) > 0 && snapshotAgeMs < NEWS_CACHE_FRESH_MS;

    let news: NewsItem[];
    let newsError: string | null;
    let newsLive: boolean;
    if (cacheIsFresh) {
      news = snapshot!.news;
      newsError = null;
      newsLive = false;
    } else {
      const liveResult = await collectNews();
      newsLive = liveResult.news.length > 0;
      news = newsLive ? liveResult.news : (snapshot?.news ?? []);
      newsError = liveResult.news.length === 0 ? liveResult.error : null;
    }

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
          news,
          portfolio,
          intraday,
          marketPhase,
          relativeStrengthNote: rs.noteFor(sd.ticker),
          backtest: backtest?.perTicker[sd.ticker] ?? null,
          // DART 라이브 호출이 비었으면(키 미설정/일시 오류) 자동수집 스냅샷의 직전 공시로 대체
          disclosures:
            disclosureResult.data[sd.ticker] ??
            snapshot?.signals?.find((s) => s.ticker === sd.ticker)?.disclosures ??
            [],
        }),
      );
    }

    if (signals.length === 0) {
      return NextResponse.json({ error: "시세 데이터를 가져오지 못했습니다. 잠시 후 다시 시도해주세요." }, { status: 502 });
    }

    const masterScore = computeMasterScore(signals);

    const { advice, error: adviceError } = await generateAdvice({
      signals,
      macro,
      news,
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
      masterScore,
      news,
      newsError,
      macro,
      marketPhase,
      relativeStrengthSummary: rs.summary,
      sectorConcentrationWarning: concentration.warning,
      backtestDisclaimer: backtest?.disclaimer ?? null,
      aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
      newsLive,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
