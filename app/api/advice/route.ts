// AI 정밀 분석: 시세/지표(일봉+장중) 수집 → 뉴스 수집(Gemini) → 룰 엔진 → Claude 최종 판단
import { NextResponse } from "next/server";
import { getMacroSnapshot, getStockCandles, getStockIntradayCandles, getStockQuote, sessionPrevClose } from "@/lib/market";
import dipStatsData from "@/data/dip-stats.json";
import { collectNews } from "@/lib/gemini";
import { mergeNews } from "@/lib/newsSignal";
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
import { isCrypto, isSemiconductor, STOCKS, TICKER_LIST } from "@/lib/types";
import { fetchLatestSnapshot } from "@/lib/snapshot";
import { fetchBacktestSnapshot } from "@/lib/backtest";
import eventsData from "@/data/events.json";
import scenarioData from "@/data/scenarios.json";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// AI 조언 5분 캐시 (서버 인스턴스 메모리 — Vercel 웜 인스턴스에서만 살아 있다. 없으면 그냥 다시 부른다)
const adviceCache = new Map<string, { advice: import("@/lib/types").AiAdvice; usage: import("@/lib/claude").AdviceUsage | null; at: number; actionSig: string }>();

/**
 * 클라이언트가 보낸 포트폴리오를 신뢰하지 않고 정규화한다.
 *
 * 정상 사용에서는 우리 화면이 만든 값이 오지만, localStorage가 부분 저장되거나(폰 저장공간 부족·
 * 브라우저 강제 종료) 손상되면 holdings가 문자열이거나 ticker가 추적 목록에 없는 값일 수 있다.
 * 그대로 두면 STOCKS[ticker].currency에서 터져 500 + 내부 TypeError가 사용자에게 그대로 노출된다.
 * 값을 버릴지언정 분석 자체는 돌아가야 한다 — 사용자는 그때 화면에서 자산을 다시 입력하면 된다.
 */
function normalizePortfolio(raw: unknown): { portfolio: Portfolio; normalized: string | null } {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const notes: string[] = [];
  const num = (v: unknown, dflt: number, label: string) => {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
    if (v != null) notes.push(`${label} 값이 잘못돼 기본값으로 대체`);
    return dflt;
  };
  if (!raw || typeof raw !== "object") notes.push("자산 정보를 받지 못해 기본값(현금 2,000만원)으로 계산");
  const rawHoldings = Array.isArray(src.holdings) ? src.holdings : [];
  const holdings = rawHoldings
    .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === "object")
    // 추적 목록에 없는 종목은 조용히 버린다 (STOCKS 조회가 undefined가 되는 것을 막는다)
    .filter((h) => typeof h.ticker === "string" && (h.ticker as string) in STOCKS)
    .map((h) => ({
      ticker: h.ticker as Portfolio["holdings"][number]["ticker"],
      // 가상자산은 소수점 수량(0.0123 BTC) — 주식만 정수로 내린다
      qty: (h.ticker as string) in STOCKS && STOCKS[h.ticker as Portfolio["holdings"][number]["ticker"]].market === "CRYPTO"
        ? Math.floor(num(h.qty, 0, "보유 수량") * 1e8) / 1e8
        : Math.floor(num(h.qty, 0, "보유 수량")),
      avgPrice: num(h.avgPrice, 0, "평단가"),
    }));
  // 수량은 있는데 평단가가 0인 항목은 "보유"로 계산할 수 없다(손익·손절선 근거가 없다) — 버리되 알린다.
  const incomplete = holdings.filter((h) => h.qty > 0 && !(h.avgPrice > 0)).map((h) => STOCKS[h.ticker].name);
  if (incomplete.length) notes.push(`${incomplete.join("·")}: 평단가가 없어 미보유로 계산 — "내 자산 입력"에서 평단가를 넣으세요`);
  const cash = num(src.cash, 20_000_000, "현금");
  return {
    portfolio: {
      cash,
      cashUSD: num(src.cashUSD, 0, "달러현금"),
      cashCrypto: num(src.cashCrypto, 0, "거래소 예수금"),
      holdings: holdings.filter((h) => h.qty > 0 && h.avgPrice > 0),
    },
    normalized: notes.length ? notes.join(" / ") : null,
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { portfolio?: unknown } | null;
    const { portfolio, normalized: portfolioNotice } = normalizePortfolio(body?.portfolio);

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
    // 뉴스 나이는 "뉴스가 실제 수집된 시각"(newsCollectedAt) 기준 — collectedAt은 Gemini가 실패해
    // 직전 뉴스를 이어 쓴 스냅샷에서도 새로 찍히기 때문이다.
    const newsAtIso = snapshot?.newsCollectedAt ?? snapshot?.collectedAt ?? null;
    const newsAgeMs = newsAtIso ? Date.now() - new Date(newsAtIso).getTime() : Infinity;
    const cacheIsFresh = Boolean(snapshot) && (snapshot?.news.length ?? 0) > 0 && newsAgeMs < NEWS_CACHE_FRESH_MS;

    // 오래된 스냅샷 뉴스를 쓸 때는 "속보" 표시를 지우고 예정 이벤트 남은 시간을 경과분만큼 줄인다.
    // 예전에는 며칠 된 [속보]가 그대로 살아 쇼크 오버레이(예산 70%)와 ×1.3 가중치를 켰다.
    const ageNews = (items: NewsItem[], ageMs: number): NewsItem[] => {
      const ageH = ageMs / 3_600_000;
      if (!(ageH > 3)) return items;
      return items.map((n) => ({
        ...n,
        isBreaking: false,
        eventInHours: n.eventInHours != null ? n.eventInHours - ageH : undefined,
      }));
    };

    let news: NewsItem[];
    let newsError: string | null;
    let newsLive: boolean;
    let newsCollectedAt: string | null;
    if (cacheIsFresh) {
      news = snapshot!.news;
      newsError = null;
      newsLive = false;
      newsCollectedAt = newsAtIso;
    } else {
      // 증분 수집 — 스냅샷 뉴스(12시간 창)를 알고 있다고 알리고 새 기사만 받아 병합한다. 토큰은 줄고 커버리지는 유지.
      const snapNews = snapshot?.news ?? [];
      const liveResult = await collectNews({ knownTitles: snapNews.map((n) => n.title) });
      newsLive = liveResult.error == null;
      news = newsLive
        ? mergeNews(snapNews, liveResult.news, new Date(), newsAtIso ?? undefined)
        : ageNews(snapNews, newsAgeMs);
      newsError = newsLive ? null : liveResult.error;
      newsCollectedAt = newsLive ? new Date().toISOString() : newsAtIso;
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
      withQuote.filter((sd) => !isSemiconductor(sd.ticker) && !isCrypto(sd.ticker)).map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
      "비반도체",
    );
    const rsCrypto = computeRelativeStrength(
      withQuote.filter((sd) => isCrypto(sd.ticker)).map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
      "가상자산",
    );
    const relativeStrengthSummary = [rsKR.summary, rsUS.summary, rsCrypto.summary].filter(Boolean).join("\n") || null;
    const noteFor = (ticker: (typeof TICKER_LIST)[number]) =>
      isCrypto(ticker) ? rsCrypto.noteFor(ticker) : isSemiconductor(ticker) ? rsKR.noteFor(ticker) : rsUS.noteFor(ticker);

    // 섹터 집중도 (국내 반도체 + 해외 반도체(엔비디아) — 결국 같은 반도체 섹터라 분산투자 착시 방지).
    // 통화가 섞여 있으므로 원/달러 환율로 원화 환산해 비교한다.
    const quotesMap = Object.fromEntries(stockData.map((sd) => [sd.ticker, sd.quote]));
    const usdKrwRate = macro.usdkrw?.price ?? null;
    const toKrw = (value: number, currency: "KRW" | "USD") => (currency === "USD" && usdKrwRate ? value * usdKrwRate : value);
    const holdingsValueKrw = portfolio.holdings.reduce((a, h) => {
      const price = quotesMap[h.ticker]?.price ?? h.avgPrice;
      return a + toKrw(h.qty * price, STOCKS[h.ticker].currency);
    }, 0);
    const totalAssetKrw = portfolio.cash + toKrw(portfolio.cashUSD, "USD") + (portfolio.cashCrypto ?? 0) + holdingsValueKrw;
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
    // 가상자산은 거래소 지갑(예수금 + 코인 평가금) — 증권사 현금과 섞어 비중을 재면 틀린다
    const cryptoHoldingsValue = portfolio.holdings
      .filter((h) => STOCKS[h.ticker].market === "CRYPTO")
      .reduce((a, h) => a + h.qty * (quotesMap[h.ticker]?.price ?? h.avgPrice), 0);
    const totalAssetCrypto = (portfolio.cashCrypto ?? 0) + cryptoHoldingsValue;

    // 상관이 높은 종목 쌍의 합산 비중 한도 — 종목당 50% 규칙만으로는
    // "삼성전자 50% + SK하이닉스 50% = 100%"가 분산으로 통과되는 구멍이 있다.
    // 평가금 0인 종목도 넘겨야 신규매수 한도가 계산된다. 지갑이 다른 가상자산은 따로 잰다(BTC·ETH 상관 0.8+).
    const capInput = (market: "KR" | "CRYPTO") =>
      stockData
        .filter((sd) => STOCKS[sd.ticker].market === market)
        .map((sd) => ({
          ticker: sd.ticker,
          name: STOCKS[sd.ticker].name,
          value: (portfolio.holdings.find((h) => h.ticker === sd.ticker)?.qty ?? 0) * (sd.quote?.price ?? 0),
          candles: sd.candles,
        }));
    const corrCap = computeCorrelationCap(capInput("KR"), totalAssetKR);
    const corrCapCrypto = computeCorrelationCap(capInput("CRYPTO"), totalAssetCrypto);

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
          marketPhase: market === "KR" ? marketPhaseKR : market === "US" ? marketPhaseUS : getMarketPhaseForMarket("CRYPTO"),
          relativeStrengthNote: noteFor(sd.ticker),
          backtest: backtest?.perTicker[sd.ticker] ?? null,
          portfolioTotalAsset: market === "KR" ? totalAssetKR : market === "US" ? totalAssetUS : totalAssetCrypto,
          changePct: sd.quote.changePct,
          // 장전·휴일에는 마지막 체결이 전 거래일이라 quote.prevClose가 "그저께 종가"다 — 상한가·VI 기준은 현재가(=전일 종가)
          prevClose: sessionPrevClose(sd.quote),
          dailyStopTriggered: dailyRisk.stopTriggered,
          creditTrend,
          scenarioTable: scenarioData as unknown as import("@/lib/scenario").ScenarioTable,
          correlationHeadroom:
            market === "KR" ? corrCap.headroom[sd.ticker] ?? null : market === "CRYPTO" ? corrCapCrypto.headroom[sd.ticker] ?? null : null,
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
      {
        // 눌림목 수량도 엔진과 같은 상관 한도를 받는다(예전엔 총자산 40%×2종목까지 무제한이었다)
        headroom: corrCap.available ? corrCap.headroom : undefined,
        // 눌림목 규칙의 보수적 검증 결과 — 우위가 확인되지 않으면 플레이북을 내지 않는다
        dipStats: dipStatsData as unknown as import("@/lib/genius").DipBuyStats,
      },
    );

    // 같은 자산·같은 엔진 결론으로 5분 안에 다시 누르면 Claude를 다시 부르지 않는다 — 결과가 같을 수밖에 없는 호출이다.
    // (엔진 신호·시세·뉴스는 매번 새로 계산하고, AI 조언만 재사용한다. 엔진 행동이 하나라도 바뀌면 다시 부른다)
    const ADVICE_CACHE_MS = 5 * 60_000;
    const actionSig = signals.map((s) => `${s.ticker}:${s.action}:${s.entryBlocked ? 1 : 0}`).join(",");
    const cacheKey = JSON.stringify({ cash: portfolio.cash, cashCrypto: portfolio.cashCrypto ?? 0, h: portfolio.holdings });
    const hit = adviceCache.get(cacheKey);
    let advice: import("@/lib/types").AiAdvice | null;
    let adviceError: string | null;
    let adviceUsage: import("@/lib/claude").AdviceUsage | null | undefined;
    let adviceCached = false;
    if (hit && Date.now() - hit.at < ADVICE_CACHE_MS && hit.actionSig === actionSig) {
      advice = hit.advice;
      adviceError = null;
      adviceUsage = hit.usage ? { ...hit.usage, costUsd: 0 } : null;
      adviceCached = true;
    } else {
      const r = await generateAdvice({
        signals,
        macro,
        news,
        portfolio,
        events: eventsData.events,
        relativeStrengthSummary,
        sectorConcentrationWarning: concentration.warning,
        todayPlan,
        creditNote: creditTrend?.note ?? null,
        dailyRisk,
      });
      advice = r.advice;
      adviceError = r.error;
      adviceUsage = r.usage;
      if (advice && !adviceError) adviceCache.set(cacheKey, { advice, usage: r.usage ?? null, at: Date.now(), actionSig });
    }

    return NextResponse.json({
      signals,
      advice,
      adviceError,
      adviceUsage: adviceUsage ?? null,
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
      newsCollectedAt,
      adviceCached, // 5분 안 재클릭이라 AI를 다시 부르지 않았음 (비용 0)
      // 보낸 자산 정보가 손상돼 기본값으로 계산했으면 화면에 알린다 — 조용히 2,000만원으로 수량을 내면 안 된다
      portfolioNotice,
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
