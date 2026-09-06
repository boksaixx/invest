// 자동 수집 에이전트 (GitHub Actions에서 30분 간격 실행)
// 시세/환율/해외지수(일봉+장중)+VIX/선물/공포탐욕지수 + Gemini 뉴스 수집 → 룰 엔진 → Claude 요약 → data/ 저장
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getMacroSnapshot, getStockCandles, getStockIntradayCandles, getStockQuote, sessionPrevClose } from "../lib/market";
import { collectNews } from "../lib/gemini";
import { fetchDartDisclosures } from "../lib/dart";
import { fetchInvestorFlows } from "../lib/investorFlow";
import { fetchCreditBalanceTrend } from "../lib/creditBalance";
import { computeMasterScore, computeRelativeStrength, runEngine } from "../lib/engine";
import { computeIntradayInsight } from "../lib/intraday";
import { getMarketPhaseForMarket } from "../lib/marketPhase";
import { generateShortSummary } from "../lib/claude";
import { fetchBacktestSnapshot } from "../lib/backtest";
import type { CollectedSnapshot, EngineSignal, Portfolio } from "../lib/types";
import { STOCKS, TICKER_LIST } from "../lib/types";

const DATA_DIR = join(process.cwd(), "data");
// 자동 수집은 보유정보 없이 시장 관점 신호를 생성한다 (보유 반영 분석은 웹앱에서 실시간 수행)
const NEUTRAL_PORTFOLIO: Portfolio = { cash: 20_000_000, cashUSD: 15_000, holdings: [] };

function kstNow(): Date {
  return new Date(Date.now() + 9 * 3600_000);
}

async function main() {
  console.log("=== 수집 시작:", new Date().toISOString(), "===");
  mkdirSync(join(DATA_DIR, "log"), { recursive: true });

  // 국내 공휴일(설날·추석·대체공휴일·선거일 등)에는 크론이 평일 스케줄대로 돌아온다.
  // 시세는 전 거래일 그대로고 장중 데이터도 없어 분석할 것이 없는데, 예전에는 15분마다
  // Gemini·Claude를 호출해 비용만 썼다. 주말 점검(일요일)은 "휴장(주말)"이라 여기 걸리지 않는다.
  // 수동 실행(workflow_dispatch)에서 강제로 돌리려면 FORCE_COLLECT=1.
  const phaseNow = getMarketPhaseForMarket("KR");
  if (phaseNow.phase === "휴장(공휴일)" && process.env.FORCE_COLLECT !== "1") {
    console.log(`국내 휴장일(${phaseNow.phase}, KST ${phaseNow.kstTime}) — 수집을 건너뜁니다 (FORCE_COLLECT=1로 강제 실행 가능)`);
    return;
  }

  const [macro, newsResult, backtest, disclosureResult, flowResult, creditTrend, ...stockData] = await Promise.all([
    getMacroSnapshot(),
    collectNews(),
    fetchBacktestSnapshot(),
    fetchDartDisclosures(),
    fetchInvestorFlows(),
    fetchCreditBalanceTrend(),
    ...TICKER_LIST.map(async (t) => {
      const quote = await getStockQuote(t);
      const [candles, rawIntraday] = await Promise.all([getStockCandles(t), getStockIntradayCandles(t)]);
      return { ticker: t, quote, candles, rawIntraday };
    }),
  ]);
  let { news, error: newsError } = newsResult;
  const marketPhaseKR = getMarketPhaseForMarket("KR");
  const marketPhaseUS = getMarketPhaseForMarket("US");
  if (disclosureResult.error) console.warn("DART 공시 수집 경고:", disclosureResult.error);
  if (flowResult.error) console.warn("KRX 수급 수집 경고:", flowResult.error);

  // Gemini 그라운딩은 무료 등급 쿼터가 빡빡해 이번 수집 주기엔 실패할 수 있다. 그 경우 뉴스를
  // 비워서 덮어쓰지 않고, 직전 성공한 수집분(너무 오래되지 않았다면)을 그대로 이어서 사용한다.
  let newsCollectedAt = new Date().toISOString();
  if (news.length === 0) {
    const prevPath = join(DATA_DIR, "latest.json");
    if (existsSync(prevPath)) {
      try {
        const prev = JSON.parse(readFileSync(prevPath, "utf8")) as CollectedSnapshot;
        // 나이는 "뉴스가 실제 수집된 시각" 기준으로 잰다 — collectedAt 기준이면 15분마다 새로 태어나
        // 3시간 상한이 영영 안 걸렸다(2026-09 감사).
        const prevNewsAt = prev.newsCollectedAt ?? prev.collectedAt;
        const prevAgeMs = Date.now() - new Date(prevNewsAt).getTime();
        if (prev.news.length > 0 && prevAgeMs < 3 * 3600_000) {
          news = prev.news;
          newsCollectedAt = prevNewsAt;
          newsError = newsError ? `${newsError} (직전 수집분으로 대체)` : null;
        }
      } catch {
        // 직전 스냅샷 파싱 실패 시 그냥 빈 뉴스로 진행
      }
    }
  }

  console.log("뉴스 수집:", news.length, "건", newsError ? `(오류: ${newsError})` : "");
  console.log("국내 장 상태:", marketPhaseKR.phase, marketPhaseKR.kstTime);
  console.log("미국 장 상태:", marketPhaseUS.phase, marketPhaseUS.kstTime);

  const withQuote = stockData.filter((sd): sd is typeof sd & { quote: NonNullable<typeof sd.quote> } => sd.quote != null);
  const rsKR = computeRelativeStrength(
    withQuote.filter((sd) => STOCKS[sd.ticker].market === "KR").map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
    "국내 반도체",
  );
  const rsUS = computeRelativeStrength(
    withQuote.filter((sd) => STOCKS[sd.ticker].market === "US").map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
    "해외 반도체",
  );
  console.log(rsKR.summary);
  console.log(rsUS.summary);
  const noteFor = (ticker: (typeof TICKER_LIST)[number]) =>
    STOCKS[ticker].market === "KR" ? rsKR.noteFor(ticker) : rsUS.noteFor(ticker);

  const signals: EngineSignal[] = [];
  for (const sd of stockData) {
    if (!sd.quote || sd.candles.length < 60) {
      console.warn(`${sd.ticker}: 시세/캔들 수집 실패 (quote=${!!sd.quote}, candles=${sd.candles.length})`);
      continue;
    }
    const intraday = computeIntradayInsight(sd.rawIntraday, sd.quote.prevClose, sd.quote.price);
    const market = STOCKS[sd.ticker].market;
    signals.push(
      runEngine({
        ticker: sd.ticker,
        price: sd.quote.price,
        candles: sd.candles,
        macro,
        news,
        portfolio: NEUTRAL_PORTFOLIO,
        intraday,
        marketPhase: market === "KR" ? marketPhaseKR : marketPhaseUS,
        relativeStrengthNote: noteFor(sd.ticker),
        backtest: backtest?.perTicker[sd.ticker] ?? null,
        changePct: sd.quote.changePct,
        prevClose: sessionPrevClose(sd.quote),
        creditTrend,
        disclosures: disclosureResult.data[sd.ticker] ?? [],
        investorFlow: flowResult.data[sd.ticker] ?? [],
      }),
    );
  }

  let aiSummary: string | null = null;
  if (signals.length > 0) {
    aiSummary = await generateShortSummary({ signals, macro, news });
  }

  const snapshot: CollectedSnapshot = {
    collectedAt: new Date().toISOString(),
    newsCollectedAt,
    quotes: Object.fromEntries(stockData.map((s) => [s.ticker, s.quote])),
    macro,
    news,
    // 예상 경로는 "조회한 그 시각" 기준이라 저장해두면 곧바로 무의미해진다. 게다가 종목당 13개
    // 지점 × 하루 26회 수집이면 저장소만 불필요하게 커진다 — 저장에서 제외하고 조회 시 재계산한다.
    signals: signals.length > 0 ? signals.map((s) => ({ ...s, forecastPath: null })) : null,
    aiSummary,
    masterScore: signals.length > 0 ? computeMasterScore(signals) : null,
  };

  writeFileSync(join(DATA_DIR, "latest.json"), JSON.stringify(snapshot, null, 1));

  // 일자별 로그 누적 (히스토리 축적 → 향후 분석 참고자료)
  const dayKey = kstNow().toISOString().slice(0, 10);
  const logPath = join(DATA_DIR, "log", `${dayKey}.json`);
  const dayLog: CollectedSnapshot[] = existsSync(logPath)
    ? (JSON.parse(readFileSync(logPath, "utf8")) as CollectedSnapshot[])
    : [];
  dayLog.push(snapshot);
  writeFileSync(logPath, JSON.stringify(dayLog, null, 1));

  console.log("=== 수집 완료 ===");
  for (const s of signals) {
    const unit = STOCKS[s.ticker].currency === "USD" ? "$" : "원";
    const priceStr = unit === "$" ? `$${s.price.toLocaleString()}` : `${s.price.toLocaleString()}원`;
    console.log(`${s.name}: ${priceStr} [${s.action}] 점수 ${s.score}`);
  }
}

main().catch((e) => {
  console.error("수집 실패:", e);
  process.exitCode = 1;
});
