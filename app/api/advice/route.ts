// AI 정밀 분석: 시세/지표(일봉+장중) 수집 → 뉴스 수집(Gemini) → 룰 엔진 → Claude 최종 판단
import { NextResponse } from "next/server";
import { getMacroSnapshot, getStockCandles, getStockIntradayCandles, getStockQuote } from "@/lib/market";
import { collectNews } from "@/lib/gemini";
import { fetchDartDisclosures, fetchRelatedDisclosures } from "@/lib/dart";
import { fetchInvestorFlows } from "@/lib/investorFlow";
import { computeMasterScore, computeRelativeStrength, computeSectorConcentration, runEngine } from "@/lib/engine";
import { computeCorrelationCap, computePortfolioRisk } from "@/lib/volatility";
import { computeDailyRisk } from "@/lib/dailyRisk";
import { computeTodayPlan } from "@/lib/genius";
import { fetchCreditBalanceTrend } from "@/lib/creditBalance";
import { computeIntradayInsight } from "@/lib/intraday";
import { getMarketPhaseForMarket } from "@/lib/marketPhase";
import { generateAdvice } from "@/lib/claude";
import type { EngineSignal, NewsItem, Portfolio } from "@/lib/types";
import { isSemiconductor, STOCKS, TICKER_LIST } from "@/lib/types";
import { fetchLatestSnapshot } from "@/lib/snapshot";
import { fetchBacktestSnapshot } from "@/lib/backtest";
import eventsData from "@/data/events.json";
import scenarioData from "@/data/scenarios.json";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 클라이언트가 보낸 포트폴리오를 신뢰하지 않고 정규화한다.
 *
 * 정상 사용에서는 우리 화면이 만든 값이 오지만, localStorage가 부분 저장되거나(폰 저장공간 부족·
 * 브라우저 강제 종료) 손상되면 holdings가 문자열이거나 ticker가 추적 목록에 없는 값일 수 있다.
 * 그대로 두면 STOCKS[ticker].currency에서 터져 500 + 내부 TypeError가 사용자에게 그대로 노출된다.
 * 값을 버릴지언정 분석 자체는 돌아가야 한다 — 사용자는 그때 화면에서 자산을 다시 입력하면 된다.
 */
function normalizePortfolio(raw: unknown): Portfolio {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, dflt: number) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const rawHoldings = Array.isArray(src.holdings) ? src.holdings : [];
  const holdings = rawHoldings
    .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === "object")
    // 추적 목록에 없는 종목은 조용히 버린다 (STOCKS 조회가 undefined가 되는 것을 막는다)
    .filter((h) => typeof h.ticker === "string" && (h.ticker as string) in STOCKS)
    .map((h) => ({
      ticker: h.ticker as Portfolio["holdings"][number]["ticker"],
      qty: Math.floor(num(h.qty, 0)),
      avgPrice: num(h.avgPrice, 0),
    }))
    .filter((h) => h.qty > 0 && h.avgPrice > 0);
  return { cash: num(src.cash, 20_000_000), cashUSD: num(src.cashUSD, 0), holdings };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { portfolio?: unknown } | null;
    const portfolio = normalizePortfolio(body?.portfolio);

    const [macro, snapshot, backtest, disclosureResult, relatedFilings, flowResult, creditTrend, ...stockData] = await Promise.all([
      getMacroSnapshot(),
      fetchLatestSnapshot(),
      fetchBacktestSnapshot(),
      fetchDartDisclosures(),
      fetchRelatedDisclosures(), // 밸류체인 관련사 공시 (선행 신호). 키 없으면 빈 배열
      fetchInvestorFlows(),
      fetchCreditBalanceTrend(), // KOFIA 신용잔고 — 실패 시 null (신호 자동 비활성)
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
    // 상대강도는 "같이 움직이는 것들끼리" 비교해야 의미가 있다. 전 종목이 국내장이므로
    // 시장이 아니라 업종으로 나눈다 — 반도체끼리(상관 0.7~0.9), 비반도체는 업종이 제각각이라
    // 순위 자체보다 "오늘 어느 업종이 버티는가"를 보는 용도다.
    const rsKR = computeRelativeStrength(
      withQuote.filter((sd) => isSemiconductor(sd.ticker)).map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
      "반도체",
    );
    const rsUS = computeRelativeStrength(
      withQuote.filter((sd) => !isSemiconductor(sd.ticker)).map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
      "비반도체",
    );
    const relativeStrengthSummary = [rsKR.summary, rsUS.summary].filter(Boolean).join("\n") || null;
    const noteFor = (ticker: (typeof TICKER_LIST)[number]) =>
      isSemiconductor(ticker) ? rsKR.noteFor(ticker) : rsUS.noteFor(ticker);

    // 섹터 집중도 (국내 반도체 + 해외 반도체(엔비디아) — 결국 같은 반도체 섹터라 분산투자 착시 방지).
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

    // 상관이 높은 종목 쌍의 합산 비중 한도 — 종목당 50% 규칙만으로는
    // "삼성전자 50% + SK하이닉스 50% = 100%"가 분산으로 통과되는 구멍이 있다.
    // 평가금 0인 종목도 넘겨야 신규매수 한도가 계산된다.
    const corrCap = computeCorrelationCap(
      stockData
        .map((sd) => ({
          ticker: sd.ticker,
          name: STOCKS[sd.ticker].name,
          value: (portfolio.holdings.find((h) => h.ticker === sd.ticker)?.qty ?? 0) * (sd.quote?.price ?? 0),
          candles: sd.candles,
        })),
      totalAssetKR,
    );

    // 하루 손실 한도 — 종목별 1% 규칙만으로는 "여러 종목이 같은 날 무너지는" 상황을 못 막는다.
    // 반도체 5종목 상관이 0.89라 사실상 한 종목이며, 실측상 -3%에서 멈추면 최대낙폭이
    // -52.0% → -42.8%로 줄었다(scripts/validate-daily-stop.ts).
    const dailyRisk = computeDailyRisk(portfolio, quotesMap, totalAssetKrw);

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
          changePct: sd.quote.changePct,
          prevClose: sd.quote.prevClose,
          dailyStopTriggered: dailyRisk.stopTriggered,
          creditTrend,
          scenarioTable: scenarioData as unknown as import("@/lib/scenario").ScenarioTable,
          correlationHeadroom: market === "KR" ? corrCap.headroom[sd.ticker] ?? null : null,
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

    // 포트폴리오 전체 위험 — 반도체주끼리 상관이 매우 높아(실측 삼성전자-SK하이닉스 0.86)
    // 종목별 위험을 따로 보면 실제 위험을 크게 과소평가한다. 원화 환산 후 상관을 반영해 합산.
    const portfolioRisk = computePortfolioRisk(
      portfolio.holdings
        .map((holding) => {
          const sd = stockData.find((s) => s.ticker === holding.ticker);
          const sig = signals.find((s) => s.ticker === holding.ticker);
          const price = sd?.quote?.price ?? holding.avgPrice;
          const currency = STOCKS[holding.ticker].currency;
          return {
            name: STOCKS[holding.ticker].name,
            value: toKrw(holding.qty * price, currency),
            candles: sd?.candles ?? [],
            sigmaDailyPct: sig?.volForecast?.sigmaDailyPct ?? NaN,
          };
        })
        .filter((p) => p.value > 0),
    );

    const masterScore = computeMasterScore(signals);

    // 오늘의 작전 — 엔진이 레짐(폭락장/급등과열/변동성확대/보통)을 판별해 그날의 플레이북을
    // 계산한다. AI 호출 없이 엔진 데이터만 사용(무료).
    const todayPlan = computeTodayPlan(
      stockData.map((sd) => {
        const sig = signals.find((s) => s.ticker === sd.ticker);
        return {
          ticker: sd.ticker,
          quote: sd.quote,
          candles: sd.candles,
          volForecast: sig?.volForecast ?? null,
          engineScore: sig?.score ?? 50,
        };
      }),
      totalAssetKR,
      portfolio.holdings,
      { soxChangePct: macro.sox?.changePct ?? null, kospiChangePct: macro.kospi?.changePct ?? null },
      scenarioData as unknown as import("@/lib/scenario").ScenarioTable,
    );

    const { advice, error: adviceError } = await generateAdvice({
      signals,
      macro,
      news,
      portfolio,
      history: snapshot,
      events: eventsData.events,
      relativeStrengthSummary,
      sectorConcentrationWarning: concentration.warning,
      todayPlan,
      creditNote: creditTrend?.note ?? null,
      dailyRisk,
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
      portfolioRisk: portfolioRisk.available ? portfolioRisk : null,
      dailyRisk: dailyRisk.available ? dailyRisk : null,
      relatedFilings,
      correlationCap: corrCap.available && corrCap.warnings.length > 0 ? { warnings: corrCap.warnings, pairs: corrCap.pairs.filter((x) => x.overCap) } : null,
      todayPlan,
      creditBalance: creditTrend,
      backtestDisclaimer: backtest?.disclaimer ?? null,
      aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
      newsLive,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    // 내부 예외 문구(TypeError, 스택 단서)를 그대로 내려보내지 않는다.
    // 사용자에게는 다음에 뭘 하면 되는지만 알려주고, 원인은 서버 로그로 남긴다.
    console.error("[/api/advice] 분석 실패:", e);
    return NextResponse.json(
      { error: "분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 계속 실패하면 '내 자산 입력'에서 보유 종목을 다시 저장해보세요." },
      { status: 500 },
    );
  }
}
