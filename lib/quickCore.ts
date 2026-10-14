// 2종목 판단 파이프라인 (빠른 판단 /api/quick 과 AI 심층 분석 /api/deep 이 함께 쓴다)
//
// 흐름: 시세·일봉·분봉·간밤 미국(엔비디아·SOX·마이크론)·수급 수집 → 룰 엔진(손절·수량·안전 규칙)
//       → 예측 모델(오늘 종가까지 / 3거래일) → 시황 국면 → 결론(lib/decide.ts)
// 뉴스는 자동수집 스냅샷(data/latest.json)에 있는 것만 쓴다.
import { fetchNaverFlows, getMacroSnapshot, getStockCandles, getStockIntradayCandles, getStockQuote, getUsOvernight, kstToday, sessionPrevClose } from "./market";
import { runEngine } from "./engine";
import { computeIntradayInsight } from "./intraday";
import { getMarketPhaseForMarket } from "./marketPhase";
import { kstMinutesNow } from "./forecastPath";
import { computeCorrelationCap } from "./volatility";
import { computeDailyRisk } from "./dailyRisk";
import { fetchLatestSnapshot } from "./snapshot";
import { loadModel } from "./modelStore";
import { contributions, predict, type Prediction, type TwoStockModel } from "./predict";
import { decide, hitRateOf, type Decision } from "./decide";
import { describeRegime, REGIME_LABEL, type RegimeKey, type RegimeView } from "./regime";
import type { Candle, EngineSignal, IntradayInsight, MacroSnapshot, MarketPhaseInfo, NewsItem, Portfolio, StockTicker } from "./types";
import { STOCKS, TICKER_LIST } from "./types";

export const IN_SESSION = ["장초반", "장중", "점심시간대", "마감임박", "동시호가"];
const REGIME_ORDER: RegimeKey[] = ["trend:up", "trend:flat", "trend:down", "vol:high", "vol:normal", "vol:calm"];

export function normalizePortfolio(raw: unknown): Portfolio {
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

/** AI 심층 분석에 넘길 종목별 원재료 (화면 응답에는 안 나간다) */
export interface StockContext {
  ticker: StockTicker;
  name: string;
  sig: EngineSignal;
  pred: Prediction;
  decision: Decision;
  regime: RegimeView;
  candles: Candle[];
  intraday: IntradayInsight;
  flows: { d: string; foreign: number; inst: number; indiv: number }[];
  holding: { qty: number; avgPrice: number } | null;
  news: NewsItem[];
  dayDrivers: { name: string; contrib: number }[];
}
export interface QuickContext {
  now: Date;
  phase: MarketPhaseInfo;
  macro: MacroSnapshot;
  overnight: Awaited<ReturnType<typeof getUsOvernight>>;
  model: TwoStockModel;
  news: NewsItem[];
  newsAgeMin: number | null;
  stocks: StockContext[];
}

export async function buildQuick(portfolio: Portfolio, now = new Date()) {
  const todayKst = kstToday(now);
  const phase = getMarketPhaseForMarket("KR", now);
  const marketOpenToday = !phase.phase.startsWith("휴장");
  const inSession = IN_SESSION.includes(phase.phase);

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
  const marketNow = {
    kospiPct: macro.kospi?.changePct ?? null,
    nqPct: macro.nasdaqFutures?.changePct ?? null,
    usdkrwPct: macro.usdkrw?.changePct ?? null,
  };

  const contexts: StockContext[] = [];
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
    const regime = describeRegime({
      f: pred.features,
      sigma: pred.sigmaDailyPct,
      overnight: { nvdaPct: overnight.nvdaPct, soxPct: overnight.soxPct, muPct: overnight.muPct },
      market: marketNow,
      dayEval: pred.dayEval ?? model.day.open.eval,
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
      regime,
    });
    const last5 = s.flows.filter((f) => f.d < todayKst || phase.phase === "장마감").slice(-5);
    const name = STOCKS[s.ticker].name;
    const related = news.filter((x) => x.relatedTo === name || x.title.includes(name) || ((x.relatedTo === "반도체" || x.relatedTo === "반도체업황") && x.impact !== "낮음"));
    const dayModel = pred.checkpoint === "pre" ? model.day.open : pred.checkpoint ? model.day[pred.checkpoint] : null;
    contexts.push({
      ticker: s.ticker, name, sig, pred, decision, regime, candles: s.candles, intraday, flows: s.flows, holding,
      news: related.slice(0, 6),
      dayDrivers: dayModel ? contributions(dayModel, pred.features).slice(0, 5).map((c) => ({ name: c.name, contrib: Math.round(c.contrib * 1000) / 1000 })) : [],
    });
    return {
      ticker: s.ticker,
      name,
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
      regime: { headline: regime.headline, lines: regime.lines.filter((l) => l.label === "추세" || l.label === "변동성"), edge: regime.edge },
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
      news: related.slice(0, 3).map((x) => ({ title: x.title, sentiment: x.sentiment, isBreaking: x.isBreaking ?? false })),
      // 이 기기의 신호 성적 채점용 — 최근 10거래일 시가·종가
      recentCloses: s.candles.slice(-10).map((c) => ({ d: c.date, o: c.open, c: c.close })),
    };
  });

  // 시장 전체 시황 (두 종목 공통): 간밤 미국 + 지금 시장
  const marketRegime = (contexts[0]?.regime.lines ?? []).filter((l) => l.label === "간밤 미국" || l.label === "지금 시장").map((l) => ({ ...l }));
  if (!inSession) for (const l of marketRegime) if (l.label === "지금 시장") l.label = phase.phase === "장전" ? "어제 시장" : phase.phase === "장마감" ? "오늘 시장" : "마지막 장";

  const q = (x: { price: number; changePct: number } | null | undefined) => (x ? { price: x.price, changePct: x.changePct } : null);
  const openEval = model.day.open.eval;
  const result = {
    updatedAt: now.toISOString(),
    phase,
    market: {
      kospi: q(macro.kospi),
      usdkrw: q(macro.usdkrw),
      nq: q(macro.nasdaqFutures),
      nvda: overnight.nvdaPct != null ? { changePct: overnight.nvdaPct } : null,
      sox: overnight.soxPct != null ? { changePct: overnight.soxPct } : null,
      mu: overnight.muPct != null ? { changePct: overnight.muPct } : null,
      usDate: overnight.usDate,
      regime: marketRegime,
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
      dayHit: hitRateOf(openEval),
      dayAuc: openEval.auc,
      dayHitByHour: Object.fromEntries(Object.entries(model.day).map(([k, v]) => [k, { auc: v.eval.auc, hit: hitRateOf(v.eval) }])),
      dayPeriod: openEval.period,
      swingAuc: model.swing.eval.auc,
      swingHit: hitRateOf(model.swing.eval),
      swingDays: model.swing.horizonDays,
      openByYear: openEval.byYear,
      // 시황(국면)별 개장 모델 성적 — 성적표 화면
      byRegime: Object.entries(openEval.byRegime ?? {})
        .map(([k, r]) => ({ key: k, label: REGIME_LABEL[k as RegimeKey] ?? k, n: r.n, auc: r.auc, hit: hitRateOf({ ...openEval, calib: r.calib, baseUpPct: r.baseUpPct }) }))
        .sort((a, b) => REGIME_ORDER.indexOf(a.key as RegimeKey) - REGIME_ORDER.indexOf(b.key as RegimeKey)),
    },
  };
  const ctx: QuickContext = {
    now, phase, macro, overnight, model, news,
    newsAgeMin: result.newsAgeMin,
    stocks: contexts,
  };
  return { result, ctx };
}

export type QuickResult = Awaited<ReturnType<typeof buildQuick>>["result"];
