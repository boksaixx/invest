// 빠른 판단 API — 삼성전자·SK하이닉스 2종목. AI 호출 없이 2~4초 안에 "지금 할 일"을 돌려준다.
//
// 흐름: 시세·일봉·분봉·간밤 미국(엔비디아·SOX)·수급 수집 → 룰 엔진(손절·수량·안전 규칙)
//       → 예측 모델(오늘 종가까지 / 3거래일) → 결론(lib/decide.ts)
// 뉴스는 자동수집 스냅샷(data/latest.json)에 있는 것만 쓴다 — 여기서 Gemini·Claude를 부르지 않는다.
import { NextResponse } from "next/server";
import { fetchNaverFlows, getMacroSnapshot, getStockCandles, getStockIntradayCandles, getStockQuote, getUsOvernight, kstToday, sessionPrevClose } from "@/lib/market";
import { runEngine } from "@/lib/engine";
import { computeIntradayInsight } from "@/lib/intraday";
import { getMarketPhaseForMarket } from "@/lib/marketPhase";
import { kstMinutesNow } from "@/lib/forecastPath";
import { computeCorrelationCap } from "@/lib/volatility";
import { computeDailyRisk } from "@/lib/dailyRisk";
import { fetchLatestSnapshot } from "@/lib/snapshot";
import { loadModel } from "@/lib/modelStore";
import { predict } from "@/lib/predict";
import { decide, hitRateOf } from "@/lib/decide";
import type { NewsItem, Portfolio, StockTicker } from "@/lib/types";
import { STOCKS, TICKER_LIST } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function normalize(raw: unknown): Portfolio {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = typeof v === "number" ? v : Number(v);
    return Number.isFinite(x) && x >= 0 ? x : 0;
  };
  const holdings = (Array.isArray(src.holdings) ? src.holdings : [])
    .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === "object")
    .filter((h) => typeof h.ticker === "string" && (h.ticker as string) in STOCKS)
    .map((h) => ({ ticker: h.ticker as StockTicker, qty: Math.floor(n(h.qty)), avgPrice: n(h.avgPrice) }))
    .filter((h) => h.qty > 0 && h.avgPrice > 0);
  return { cash: n(src.cash), cashUSD: 0, cashCrypto: 0, holdings };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { portfolio?: unknown } | null;
    const portfolio = normalize(body?.portfolio);
    const now = new Date();
    const todayKst = kstToday(now);
    const phase = getMarketPhaseForMarket("KR", now);
    const marketOpenToday = !phase.phase.startsWith("휴장");

    const [macro, overnight, snapshot, model, ...stockData] = await Promise.all([
      getMacroSnapshot(),
      getUsOvernight(todayKst),
      fetchLatestSnapshot().catch(() => null),
      loadModel(),
      ...TICKER_LIST.map(async (t) => {
        const [quote, candles, raw, flows] = await Promise.all([getStockQuote(t), getStockCandles(t), getStockIntradayCandles(t), fetchNaverFlows(t)]);
        return { ticker: t, quote, candles, raw, flows };
      }),
    ]);

    // 스냅샷 뉴스: 3시간 넘은 [속보] 표시는 지운다(쇼크 오버레이가 낡은 속보로 켜지지 않게)
    const newsAt = snapshot?.newsCollectedAt ?? snapshot?.collectedAt ?? null;
    const newsAgeH = newsAt ? (now.getTime() - new Date(newsAt).getTime()) / 3_600_000 : Infinity;
    const news: NewsItem[] = (snapshot?.news ?? []).map((x) => (newsAgeH > 3 ? { ...x, isBreaking: false } : x));

    const quotes = Object.fromEntries(stockData.map((s) => [s.ticker, s.quote]));
    const holdingsValue = portfolio.holdings.reduce((a, h) => a + h.qty * (quotes[h.ticker]?.price ?? h.avgPrice), 0);
    const totalAsset = portfolio.cash + holdingsValue;
    const corrCap = computeCorrelationCap(
      stockData.map((s) => ({
        ticker: s.ticker,
        name: STOCKS[s.ticker].name,
        value: (portfolio.holdings.find((h) => h.ticker === s.ticker)?.qty ?? 0) * (s.quote?.price ?? 0),
        candles: s.candles,
      })),
      totalAsset,
    );
    const dailyRisk = computeDailyRisk(portfolio, quotes, totalAsset);
    const kstMin = kstMinutesNow(now);

    const stocks = stockData.map((s) => {
      const pair = stockData.find((x) => x.ticker !== s.ticker)!;
      if (!s.quote || s.candles.length < 60) {
        return { ticker: s.ticker, name: STOCKS[s.ticker].name, error: "시세를 가져오지 못했어요" };
      }
      const intraday = computeIntradayInsight(s.raw, s.quote.prevClose, s.quote.price, now);
      const sig = runEngine({
        ticker: s.ticker,
        price: s.quote.price,
        candles: s.candles,
        macro,
        news,
        portfolio,
        intraday,
        marketPhase: phase,
        portfolioTotalAsset: totalAsset,
        changePct: s.quote.changePct,
        prevClose: sessionPrevClose(s.quote, now),
        dailyStopTriggered: dailyRisk.stopTriggered,
        correlationHeadroom: corrCap.available ? (corrCap.headroom[s.ticker] ?? null) : null,
        investorFlow: s.flows.map((f) => ({ date: f.d, foreignNet: f.foreign, institutionNet: f.inst })),
      });
      const live = intraday.available && intraday.isToday;
      const pred = predict({
        model,
        candles: s.candles,
        pairCandles: pair.candles,
        flows: s.flows,
        overnight,
        intraday: live ? { open: intraday.todayOpen, high: intraday.todayHigh, low: intraday.todayLow, price: s.quote.price } : null,
        kstMinutes: kstMin,
        todayKst,
        marketOpenToday,
      });
      const holding = portfolio.holdings.find((h) => h.ticker === s.ticker) ?? null;
      const decision = decide({
        sig,
        pred,
        holding,
        cash: portfolio.cash,
        totalAsset,
        correlationHeadroom: corrCap.available ? (corrCap.headroom[s.ticker] ?? null) : null,
        phase,
        dailyStopTriggered: dailyRisk.stopTriggered,
        swingDays: model.swing.horizonDays,
      });
      const last5 = s.flows.filter((f) => f.d < todayKst || phase.phase === "장마감").slice(-5);
      const tickerNews = news
        .filter((x) => x.relatedTo === STOCKS[s.ticker].name || x.title.includes(STOCKS[s.ticker].name) || (x.relatedTo === "반도체" && x.impact === "높음"))
        .slice(0, 3)
        .map((x) => ({ title: x.title, sentiment: x.sentiment, isBreaking: x.isBreaking ?? false }));
      return {
        ticker: s.ticker,
        name: STOCKS[s.ticker].name,
        price: s.quote.price,
        change: s.quote.change,
        changePct: s.quote.changePct,
        quoteTime: s.quote.time,
        today: live ? { open: intraday.todayOpen, high: intraday.todayHigh, low: intraday.todayLow, vwap: intraday.vwap } : null,
        decision,
        prediction: {
          checkpoint: pred.checkpoint,
          dayProb: pred.dayProb,
          swingProb: pred.swingProb,
          swingReasons: pred.swingReasons,
          sigmaDailyPct: pred.sigmaDailyPct,
        },
        engine: {
          stopPrice: sig.stopPrice,
          breakEvenPrice: sig.breakEvenPrice,
          pnlPct: sig.pnlPct,
          volRegime: sig.volForecast?.available ? sig.volForecast.regime : null,
          range90: sig.volForecast?.available ? sig.volForecast.range90 : null,
        },
        flows5: last5.length
          ? { foreign: last5.reduce((a, f) => a + f.foreign, 0), inst: last5.reduce((a, f) => a + f.inst, 0), indiv: last5.reduce((a, f) => a + f.indiv, 0), days: last5.length }
          : null,
        news: tickerNews,
        // 이 기기의 신호 성적 채점용 — 최근 10거래일 종가
        recentCloses: s.candles.slice(-10).map((c) => ({ d: c.date, c: c.close })),
      };
    });

    const q = (x: { price: number; changePct: number } | null | undefined) => (x ? { price: x.price, changePct: x.changePct } : null);
    return NextResponse.json({
      updatedAt: now.toISOString(),
      phase,
      market: {
        kospi: q(macro.kospi),
        usdkrw: q(macro.usdkrw),
        nvda: overnight.nvdaPct != null ? { changePct: overnight.nvdaPct } : null,
        sox: overnight.soxPct != null ? { changePct: overnight.soxPct } : null,
        usDate: overnight.usDate,
      },
      account: {
        cash: portfolio.cash,
        totalAsset,
        todayPnlWon: dailyRisk.available ? dailyRisk.todayPnlWon : 0,
        todayPnlPct: dailyRisk.available ? dailyRisk.todayPnlPct : 0,
        dailyStop: dailyRisk.stopTriggered,
        dailyWarn: dailyRisk.warnTriggered,
      },
      stocks,
      newsAgeMin: Number.isFinite(newsAgeH) ? Math.round(newsAgeH * 60) : null,
      model: {
        generatedAt: model.generatedAt,
        dataRange: model.dataRange,
        dayHit: hitRateOf(model.day.open.eval),
        dayHitByHour: Object.fromEntries(Object.entries(model.day).map(([k, v]) => [k, { auc: v.eval.auc, hit: hitRateOf(v.eval) }])),
        dayPeriod: model.day.open.eval.period,
        swingAuc: model.swing.eval.auc,
        swingHit: hitRateOf(model.swing.eval),
        swingDays: model.swing.horizonDays,
        openByYear: model.day.open.eval.byYear,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `분석 중 오류가 났어요: ${String(e).slice(0, 200)}` }, { status: 500 });
  }
}
