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
import type { CollectedSnapshot, EngineSignal, NewsItem, Portfolio } from "../lib/types";
import { mergeNews } from "../lib/newsSignal";
import { isCrypto, isSemiconductor, STOCKS, TICKER_LIST } from "../lib/types";

const DATA_DIR = join(process.cwd(), "data");
// 자동 수집은 보유정보 없이 시장 관점 신호를 생성한다 (보유 반영 분석은 웹앱에서 실시간 수행)
const NEUTRAL_PORTFOLIO: Portfolio = { cash: 20_000_000, cashUSD: 15_000, cashCrypto: 5_000_000, holdings: [] };

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

  // 직전 스냅샷 — 뉴스 증분 수집(이미 아는 제목 제외)과 요약 이어쓰기의 기준
  const prevPath = join(DATA_DIR, "latest.json");
  let prev: CollectedSnapshot | null = null;
  if (existsSync(prevPath)) {
    try {
      prev = JSON.parse(readFileSync(prevPath, "utf8")) as CollectedSnapshot;
    } catch {
      prev = null;
    }
  }
  const prevNewsAt = prev?.newsCollectedAt ?? prev?.collectedAt ?? null;
  const prevNewsAgeMin = prevNewsAt ? (Date.now() - new Date(prevNewsAt).getTime()) / 60_000 : Infinity;
  // 뉴스는 NEWS_INTERVAL_MIN(기본 30분)마다만 새로 묻는다 — 엔진은 15분마다 돌아도 뉴스는 그 사이 거의 안 바뀐다.
  // 그라운딩 검색은 요청당 과금이라 호출 횟수 자체가 비용이다. 속보 지연은 최악 30분.
  const NEWS_INTERVAL_MIN = Number(process.env.NEWS_INTERVAL_MIN ?? 30);
  const askNews = !(prev?.news?.length && prevNewsAgeMin < NEWS_INTERVAL_MIN) || process.env.FORCE_NEWS === "1";
  const knownTitles = (prev?.news ?? []).map((n) => n.title);

  const [macro, newsResult, backtest, disclosureResult, flowResult, creditTrend, ...stockData] = await Promise.all([
    getMacroSnapshot(),
    askNews ? collectNews({ knownTitles }) : Promise.resolve({ news: [] as NewsItem[], error: null as string | null }),
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

  // 뉴스 병합 — 직전 12시간 창의 기사에 이번에 새로 받은 기사를 얹는다(중복 제거, 속보 3시간 재계산).
  //  · 이번에 안 물었으면(간격 미도달) 직전 것을 그대로 (나이는 prevNewsAt 유지)
  //  · 물었는데 새 기사가 0건이면 정상(증분) — 직전 것을 이어 쓰되 수집 시각은 지금으로
  //  · Gemini가 실패했으면 직전 것을 이어 쓰고 오류를 남긴다(예전처럼 3시간 넘으면 버린다)
  const prevNews = prev?.news ?? [];
  let newsCollectedAt = prevNewsAt ?? new Date().toISOString();
  if (askNews) {
    if (newsError && news.length === 0) {
      if (prevNewsAgeMin < 180) {
        news = mergeNews(prevNews, [], new Date(), prevNewsAt ?? undefined);
        newsError = `${newsError} (직전 수집분으로 대체)`;
      }
    } else {
      news = mergeNews(prevNews, news, new Date(), prevNewsAt ?? undefined);
      newsCollectedAt = new Date().toISOString();
      console.log(`뉴스 증분: 새 ${newsResult.news.length}건 + 이전 ${prevNews.length}건 → 병합 ${news.length}건`);
    }
  } else {
    news = mergeNews(prevNews, [], new Date(), prevNewsAt ?? undefined);
    console.log(`뉴스 재사용: ${Math.round(prevNewsAgeMin)}분 전 수집분 ${news.length}건 (다음 수집까지 ${Math.max(0, Math.round(NEWS_INTERVAL_MIN - prevNewsAgeMin))}분)`);
  }

  console.log("뉴스 수집:", news.length, "건", newsError ? `(오류: ${newsError})` : "");
  console.log("국내 장 상태:", marketPhaseKR.phase, marketPhaseKR.kstTime);
  console.log("미국 장 상태:", marketPhaseUS.phase, marketPhaseUS.kstTime);

  const withQuote = stockData.filter((sd): sd is typeof sd & { quote: NonNullable<typeof sd.quote> } => sd.quote != null);
  // 상대강도는 "같이 움직이는 것들끼리" — 반도체 / 비반도체 / 가상자산 세 그룹
  const rsSemi = computeRelativeStrength(
    withQuote.filter((sd) => isSemiconductor(sd.ticker)).map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
    "반도체",
  );
  const rsOther = computeRelativeStrength(
    withQuote.filter((sd) => !isSemiconductor(sd.ticker) && !isCrypto(sd.ticker)).map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
    "비반도체",
  );
  const rsCrypto = computeRelativeStrength(
    withQuote.filter((sd) => isCrypto(sd.ticker)).map((sd) => ({ ticker: sd.ticker, changePct: sd.quote.changePct })),
    "가상자산",
  );
  console.log(rsSemi.summary);
  console.log(rsOther.summary);
  console.log(rsCrypto.summary);
  const noteFor = (ticker: (typeof TICKER_LIST)[number]) =>
    isCrypto(ticker) ? rsCrypto.noteFor(ticker) : isSemiconductor(ticker) ? rsSemi.noteFor(ticker) : rsOther.noteFor(ticker);

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
        marketPhase: market === "KR" ? marketPhaseKR : market === "US" ? marketPhaseUS : getMarketPhaseForMarket("CRYPTO"),
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

  // AI 짧은 요약(aiSummary)은 화면·AI 페이로드 어디에도 쓰이지 않고 latest.json에만 남는 "사람용 브리핑"이다.
  // 예전에는 15분마다 Haiku를 불렀다(하루 약 28회) — 개장 전(08:30)·마감 후(16:10) 두 번이면 충분하고,
  // 그 사이엔 직전 요약을 이어 쓴다. 강제로 만들려면 FORCE_SUMMARY=1.
  const wantSummary = process.env.FORCE_SUMMARY === "1" || marketPhaseKR.phase === "장전" || marketPhaseKR.phase === "장마감";
  let aiSummary: string | null = prev?.aiSummary ?? null;
  if (signals.length > 0 && wantSummary) {
    aiSummary = (await generateShortSummary({ signals, macro, news })) ?? aiSummary;
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
