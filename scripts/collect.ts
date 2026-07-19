// 자동 수집 에이전트 (GitHub Actions에서 30분 간격 실행)
// 시세/환율/해외지수(일봉+장중) + Gemini 뉴스 수집 → 룰 엔진 → Claude 요약 → data/ 저장 → (선택) 카카오톡 전송
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getMacroSnapshot, getStockCandles, getStockIntradayCandles, getStockQuote } from "../lib/market";
import { collectNews } from "../lib/gemini";
import { computeRelativeStrength, runEngine } from "../lib/engine";
import { computeIntradayInsight } from "../lib/intraday";
import { getMarketPhase } from "../lib/marketPhase";
import { generateShortSummary } from "../lib/claude";
import { sendKakaoMemo } from "../lib/kakao";
import type { CollectedSnapshot, EngineSignal, Portfolio, StockTicker } from "../lib/types";

const DATA_DIR = join(process.cwd(), "data");
const TICKERS: StockTicker[] = ["005930", "000660"];
// 자동 수집은 보유정보 없이 시장 관점 신호를 생성한다 (보유 반영 분석은 웹앱에서 실시간 수행)
const NEUTRAL_PORTFOLIO: Portfolio = { cash: 20_000_000, holdings: [] };

function kstNow(): Date {
  return new Date(Date.now() + 9 * 3600_000);
}

async function main() {
  console.log("=== 수집 시작:", new Date().toISOString(), "===");
  mkdirSync(join(DATA_DIR, "log"), { recursive: true });

  const prev: CollectedSnapshot | null = existsSync(join(DATA_DIR, "latest.json"))
    ? (JSON.parse(readFileSync(join(DATA_DIR, "latest.json"), "utf8")) as CollectedSnapshot)
    : null;

  const [macro, newsResult, ...stockData] = await Promise.all([
    getMacroSnapshot(),
    collectNews(),
    ...TICKERS.map(async (t) => {
      const quote = await getStockQuote(t);
      const [candles, rawIntraday] = await Promise.all([getStockCandles(t), getStockIntradayCandles(t)]);
      return { ticker: t, quote, candles, rawIntraday };
    }),
  ]);
  const { news, error: newsError } = newsResult;
  const marketPhase = getMarketPhase();

  console.log("뉴스 수집:", news.length, "건", newsError ? `(오류: ${newsError})` : "");
  console.log("장 상태:", marketPhase.phase, marketPhase.kstTime);

  const withQuote = stockData.filter((sd): sd is typeof sd & { quote: NonNullable<typeof sd.quote> } => sd.quote != null);
  let relativeStrengthNote: string | null = null;
  if (withQuote.length === 2) {
    const [a, b] = withQuote;
    relativeStrengthNote = computeRelativeStrength(
      { ticker: a.ticker, changePct: a.quote.changePct },
      { ticker: b.ticker, changePct: b.quote.changePct },
    ).note;
  }

  const signals: EngineSignal[] = [];
  for (const sd of stockData) {
    if (!sd.quote || sd.candles.length < 60) {
      console.warn(`${sd.ticker}: 시세/캔들 수집 실패 (quote=${!!sd.quote}, candles=${sd.candles.length})`);
      continue;
    }
    const intraday = computeIntradayInsight(sd.rawIntraday, sd.quote.prevClose, sd.quote.price);
    signals.push(
      runEngine({
        ticker: sd.ticker,
        price: sd.quote.price,
        candles: sd.candles,
        macro,
        news,
        portfolio: NEUTRAL_PORTFOLIO,
        intraday,
        marketPhase,
        relativeStrengthNote,
      }),
    );
  }

  let aiSummary: string | null = null;
  if (signals.length > 0) {
    aiSummary = await generateShortSummary({ signals, macro, news });
  }

  const snapshot: CollectedSnapshot = {
    collectedAt: new Date().toISOString(),
    quotes: Object.fromEntries(stockData.map((s) => [s.ticker, s.quote])),
    macro,
    news,
    signals: signals.length > 0 ? signals : null,
    aiSummary,
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

  // 카카오톡 전송 판단: 신호가 바뀌었거나, 강한 신호이거나, 강제 전송 플래그일 때만 (스팸 방지)
  const prevActions = new Map((prev?.signals ?? []).map((s) => [s.ticker, s.action]));
  const changed = signals.some((s) => prevActions.get(s.ticker) !== s.action);
  const strong = signals.some((s) => s.action !== "관망" && s.action !== "보유");
  const force = process.env.FORCE_KAKAO === "1";

  if (aiSummary && (force || (changed && strong) || (changed && prev !== null))) {
    const header = `📈 반도체 트레이딩 AI (${marketPhase.kstTime} KST · ${marketPhase.phase})`;
    const lines = signals
      .map((s) => `· ${s.name} ${s.price.toLocaleString()}원 → [${s.action}] 점수 ${s.score}`)
      .join("\n");
    const sent = await sendKakaoMemo(`${header}\n${lines}\n\n${aiSummary}`);
    console.log("카카오톡 전송:", sent ? "성공" : "미전송(설정 없음 또는 실패)");
  } else {
    console.log("카카오톡 전송 조건 미충족 (신호 변화 없음)");
  }

  console.log("=== 수집 완료 ===");
  for (const s of signals) {
    console.log(`${s.name}: ${s.price.toLocaleString()}원 [${s.action}] 점수 ${s.score}`);
  }
}

main().catch((e) => {
  console.error("수집 실패:", e);
  process.exitCode = 1;
});
