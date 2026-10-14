// AI 심층 분석 가드레일 회귀 테스트 — "AI가 검증된 결론을 뒤집지 못하는가"
//
// 실행: npx tsx scripts/validate-deep.ts   (npm run validate:rules 에 포함)
import { buildDeepPayload, guardDeep, type DeepStock } from "../lib/deepAnalysis";
import type { QuickContext, StockContext } from "../lib/quickCore";
import model from "../data/model.json";
import type { TwoStockModel } from "../lib/predict";

let fail = 0;
const ok = (c: boolean, m: string) => {
  if (!c) fail++;
  console.log(`${c ? "✅" : "❌"} ${m}`);
};

const candles = Array.from({ length: 80 }, (_, i) => ({ date: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`, open: 230000, high: 235000, low: 226000, close: 231000 + (i % 5) * 500, volume: 1e7 }));
const stock = (ticker: "005930" | "000660", dayProb: number | null, verdict: string, tone: string, title: string): StockContext =>
  ({
    ticker, name: ticker === "005930" ? "삼성전자" : "SK하이닉스",
    sig: { price: 232000, indicators: { ma5: 231000, ma20: 240000, ma60: 250000, pivotR1: 236000, pivotS1: 228000, rsi14: 40, adx14: 20, volumeZ: 0.3, ma20SlopePct: -1 }, stopPrice: 225000, breakEvenPrice: null, volForecast: null, warnings: [], pnlPct: null },
    pred: { dayProb, checkpoint: "h10", swingProb: 0.5, dayReasons: [], sigmaDailyPct: 3 },
    decision: { verdict, tone, title, summary: "", plan: [], timing: null, cautions: [], day: null },
    regime: { headline: "하락 추세 · 보통 장", lines: [], edge: null, keys: [] },
    candles, intraday: { available: false }, flows: [], holding: null, news: [], dayDrivers: [],
  }) as unknown as StockContext;
const ctx = (stocks: StockContext[]): QuickContext =>
  ({
    now: new Date("2026-10-15T01:10:00Z"),
    phase: { phase: "장중", kstTime: "10:10", note: "" },
    macro: { kospi: null, nasdaqFutures: null, usdkrw: null, vix: null, us10y: null },
    overnight: { nvdaPct: 1, soxPct: 0.5, muPct: -1, nvdaSigma: 2, soxSigma: 2, muSigma: 3, usDate: "2026-10-14" },
    model: model as unknown as TwoStockModel,
    news: [], newsAgeMin: 10, stocks,
  }) as unknown as QuickContext;
const ai = (ticker: "005930" | "000660", stance: DeepStock["stance"], conclusion = "기다리세요.", scenarios: DeepStock["scenarios"] = []): DeepStock => ({
  ticker, headline: "", stance, confidence: "보통", market: "", trend: "", flow: "", news: "", conclusion, scenarios, watch: [], risks: [],
});

// ① 모델이 "밀린다"(40%)인데 AI가 "오른다" → 중립으로
let c = ctx([stock("005930", 0.4, "wait", "wait", "기다리세요")]);
let g = guardDeep({ marketView: "", stocks: [ai("005930", "up")] }, c);
ok(g.stocks[0].stance === "neutral" && (g.stocks[0].guard?.length ?? 0) > 0, "확률 40%인데 AI가 '오른다' → 중립으로 바꾸고 표시");
// ② 모델이 반반(50%)이면 AI가 기울 수 있다
c = ctx([stock("005930", 0.5, "wait", "wait", "기다리세요")]);
g = guardDeep({ marketView: "", stocks: [ai("005930", "down")] }, c);
ok(g.stocks[0].stance === "down" && !g.stocks[0].guard, "확률 50%(반반)면 AI의 기울기를 그대로 둔다");
// ③ 손절 결론인데 AI가 "오른다" → 중립
c = ctx([stock("005930", 0.5, "stop_loss", "danger", "지금 파세요")]);
g = guardDeep({ marketView: "", stocks: [ai("005930", "up")] }, c);
ok(g.stocks[0].stance === "neutral", "손절 결론에서 AI가 '오른다' → 중립");
// ④ 기다리세요 결론인데 AI가 "지금 사세요"라고 쓰면 문장을 고친다
c = ctx([stock("005930", 0.58, "wait", "wait", "기다리세요")]);
g = guardDeep({ marketView: "", stocks: [ai("005930", "up", "흐름이 좋으니 지금 사세요. 손절가는 225,000원이에요.")] }, c);
ok(!/사세요/.test(g.stocks[0].conclusion) && g.stocks[0].conclusion.includes("기다리세요") && g.stocks[0].conclusion.includes("225,000원"), `결론과 다른 매수 권유 수정 → "${g.stocks[0].conclusion}"`);
// ⑤ 시나리오 가격이 현재가 ±15% 밖이면 지우고, 안이면 호가 단위로 맞춘다
g = guardDeep({ marketView: "", stocks: [ai("005930", "neutral", "기다리세요.", [
  { trigger: "500,000원 위로", price: 500000, action: "x" },
  { trigger: "236,120원 위로", price: 236120, action: "y" },
])] }, c);
ok(g.stocks[0].scenarios[0].price === 0 && g.stocks[0].scenarios[1].price === 236000, `시나리오 가격 점검 (${g.stocks[0].scenarios.map((x) => x.price).join(", ")})`);
// ⑥ 매수 결론 + AI 오른다 → 그대로, 채점용 시점 정보 기록
c = ctx([stock("000660", 0.6, "buy_now", "buy", "지금 사세요")]);
g = guardDeep({ marketView: "", stocks: [ai("000660", "up", "지금 사세요. 손절가 225,000원.")] }, c);
ok(g.stocks[0].stance === "up" && !g.stocks[0].guard && g.stocks[0].at?.price === 232000 && g.stocks[0].at?.inSession === true, "매수 결론과 같은 방향이면 그대로 + 채점 정보 기록");
// ⑦ 페이로드: 검증된 사실·결론 고정·숫자가 들어가는지
const p = buildDeepPayload(ctx([stock("005930", 0.6, "buy_now", "buy", "지금 사세요")]));
ok(p.validatedFacts.length >= 8 && p.stocks[0].decision.title === "지금 사세요" && p.stocks[0].levels.ma20 === 240000, "페이로드에 검증된 사실·고정 결론·가격대 포함");
ok(JSON.stringify(p).length < 30000, `페이로드 크기 ${JSON.stringify(p).length}자`);

console.log(fail === 0 ? "\n전체 통과" : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
