// AI 정밀 분석: 시세/지표(일봉+장중) 수집 → 뉴스 수집(Gemini) → 룰 엔진 → Claude 최종 판단
import { NextResponse } from "next/server";
import { getMacroSnapshot, getStockCandles, getStockIntradayCandles, getStockQuote } from "@/lib/market";
import { collectNews } from "@/lib/gemini";
import { fetchDartDisclosures } from "@/lib/dart";
import { fetchInvestorFlows } from "@/lib/investorFlow";
import { computeMasterScore, computeRelativeStrength, computeSectorConcentration, runEngine } from "@/lib/engine";
import { computeIntradayInsight } from "@/lib/intraday";
import { getMarketPhaseForMarket } from "@/lib/marketPhase";
import { generateAdvice } from "@/lib/claude";
import type { EngineSignal, NewsItem, Portfolio } from "@/lib/types";
import { STOCKS, TICKER_LIST } from "@/lib/types";
import { fetchLatestSnapshot } from "@/lib/snapshot";
import { fetchBacktestSnapshot } from "@/lib/backtest";
import eventsData from "@/data/events.json";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { portfolio?: Portfolio };
    const portfolio: Portfolio = {
      cash: body.portfolio?.cash ?? 20_000_000,
      cashUSD: body.portfolio?.cashUSD ?? 0,
      holdings: body.portfolio?.holdings ?? [],
    };

    const [macro, snapshot, backtest, disclosureResult, flowResult, ...stockData] = await Promise.all([
      getMacroSnapshot(),
      fetchLatestSnapshot(),
      fetchBacktestSnapshot(),
      fetchDartDisclosures(),
      fetchInvestorFlows(),
      ...TICKER_LIST.map(async (t) => {
        const quote = await getStockQuote(t);
        const [candles, rawIntraday] = await Promise.all([getStockCandles(t), getStockIntradayCandles(t)]);
        return { ticker: t, quote, candles, rawIntraday };
      }),
    ]);
    // 국내/미국 시장은 개장시간이 달라 장상태를 따로 계산한다.
    const marketPhaseKR = getMarketPhaseForMarket("KR");
    const marketPhaseUS = getMarketPhaseForMarket("US");

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

    // 상대강도 랭킹 — 국내/미국은 통화·거래시간대가 달라 직접 비교가 무의미하므로 그룹별로 따로 계산
    const withQuote = stockData.filter((sd): sd is typeof sd & { quote: NonNullable<typeof sd.quote> } => sd.quote != null);
    const rsKR = computeRelativeStrength(
      withQuote.filter((sd) => STOCKS[sd.ticker].market === "KR").map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
      "국내 반도체",
    );
    const rsUS = computeRelativeStrength(
      withQuote.filter((sd) => STOCKS[sd.ticker].market === "US").map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
      "미국 빅테크",
    );
    const relativeStrengthSummary = [rsKR.summary, rsUS.summary].filter(Boolean).join("\n") || null;
    const noteFor = (ticker: (typeof TICKER_LIST)[number]) =>
      STOCKS[ticker].market === "KR" ? rsKR.noteFor(ticker) : rsUS.noteFor(ticker);

    // 섹터/테마 집중도 (국내 반도체 + 미국 빅테크 — 둘 다 'AI 밸류체인' 테마라 분산투자 착시 방지).
    // 통화가 섞여 있으므로 원/달러 환율로 원화 환산해 비교한다.
    const quotesMap = Object.fromEntries(stockData.map((sd) => [sd.ticker, sd.quote]));
    const usdKrwRate = macro.usdkrw?.price ?? null;
    const toKrw = (value: number, currency: "KRW" | "USD") => (currency === "USD" && usdKrwRate ? value * usdKrwRate : value);
    const holdingsValueKrw = portfolio.holdings.reduce((a, h) => {
      const price = quotesMap[h.ticker]?.price ?? h.avgPrice;
      return a + toKrw(h.qty * price, STOCKS[h.ticker].currency);
    }, 0);
    const totalAssetKrw = portfolio.cash + toKrw(portfolio.cashUSD, "USD") + holdingsValueKrw;
    const concentration = computeSectorConcentration(portfolio.holdings, quotesMap, totalAssetKrw, usdKrwRate);

    // 같은 통화(같은 시장) 기준 총자산 — 포지션 비중/예산 계산은 환율 변환 없이 같은 단위로 비교해야 하므로
    // 원화 종목엔 원화 총자산을, 달러 종목엔 달러 총자산을 넘긴다.
    const krHoldingsValue = portfolio.holdings
      .filter((h) => STOCKS[h.ticker].market === "KR")
      .reduce((a, h) => a + h.qty * (quotesMap[h.ticker]?.price ?? h.avgPrice), 0);
    const usHoldingsValue = portfolio.holdings
      .filter((h) => STOCKS[h.ticker].market === "US")
      .reduce((a, h) => a + h.qty * (quotesMap[h.ticker]?.price ?? h.avgPrice), 0);
    const totalAssetKR = portfolio.cash + krHoldingsValue;
    const totalAssetUS = portfolio.cashUSD + usHoldingsValue;

    const signals: EngineSignal[] = [];
    for (const sd of stockData) {
      if (!sd.quote || sd.candles.length < 60) continue;
      const intraday = computeIntradayInsight(sd.rawIntraday, sd.quote.prevClose, sd.quote.price);
      const market = STOCKS[sd.ticker].market;
      signals.push(
        runEngine({
          ticker: sd.ticker,
          price: sd.quote.price,
          candles: sd.candles,
          macro,
          news,
          portfolio,
          intraday,
          marketPhase: market === "KR" ? marketPhaseKR : marketPhaseUS,
          relativeStrengthNote: noteFor(sd.ticker),
          backtest: backtest?.perTicker[sd.ticker] ?? null,
          portfolioTotalAsset: market === "KR" ? totalAssetKR : totalAssetUS,
          // DART/KRX 라이브 호출이 비었으면(키 미설정/일시 오류) 자동수집 스냅샷의 직전 값으로 대체
          disclosures:
            disclosureResult.data[sd.ticker] ??
            snapshot?.signals?.find((s) => s.ticker === sd.ticker)?.disclosures ??
            [],
          investorFlow:
            flowResult.data[sd.ticker] ??
            snapshot?.signals?.find((s) => s.ticker === sd.ticker)?.investorFlow ??
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
      relativeStrengthSummary,
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
      marketPhase: marketPhaseKR,
      marketPhaseUS,
      relativeStrengthSummary,
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
