// 화면에 보여 줄 "한 줄 결론"을 정한다 — 삼성전자·SK하이닉스 2종목 전용.
//
// 원칙
//  1. 방향 판단은 검증된 것만 쓴다: 오늘 종가까지(단타) 모델은 워크포워드 검증 AUC 0.54~0.58로
//     매년 기준선을 넘었다(lib/predict.ts). 3거래일(스윙) 모델은 0.53으로 약해 "참고"로만 보여 주고
//     매수·매도 결론에는 쓰지 않는다.
//  2. 단타 신규 매수는 오전(장 시작 전~12시)에만 권한다 — 오후 신호는 맞아도 남은 기대수익(평균 +0.1~0.2%)이
//     왕복 거래비용(0.18%)을 넘지 못했다.
//  3. 손절·익절·하루 손실 한도·상하한가 같은 안전 규칙은 룰 엔진(lib/engine.ts) 판단을 그대로 따른다.
//  4. 문장은 짧게, 숫자는 "얼마에·몇 주·어디서 자를지"만.
import type { CalibRow, ModelEval, Prediction } from "./predict";
import type { EngineSignal, MarketPhaseInfo } from "./types";
import { roundToTick } from "./tick";
import { REGIME_LABEL, regimeEvalFor, type RegimeView } from "./regime";

export const DAY_BUY_PROB = 0.55;
export const DAY_WEAK_PROB = 0.45;
const COST_PCT = 0.18; // 왕복 거래비용(세금 0.15% + 수수료)
const MORNING = new Set(["pre", "open", "h10", "h11", "h12"]);

export type Verdict = "buy_now" | "buy_open" | "wait" | "hold" | "sell_half" | "sell_all" | "stop_loss";
export type Tone = "buy" | "sell" | "hold" | "wait" | "danger";

export interface PlanRow {
  label: string;
  value: string;
  hint?: string;
}
export interface ProbView {
  prob: number; // 0~1
  label: string; // "오를 가능성 높음" 등
  tone: "up" | "down" | "flat";
  stat: string | null; // "과거 비슷한 상황 312번 중 58% 상승"
  horizon: string; // "오늘 종가까지" / "3거래일 뒤"
  weak: boolean; // 근거가 약한 예측인지
}
export interface Decision {
  verdict: Verdict;
  title: string;
  tone: Tone;
  summary: string;
  plan: PlanRow[];
  day: ProbView | null;
  swing: ProbView | null;
  timing: string | null;
  reasons: string[];
  cautions: string[];
  /** 성적표 기록용: 이 결론이 주장하는 방향 (1=오른다, -1=내린다, 0=주장 없음)과 채점 기준 */
  claim: { dir: 1 | -1 | 0; horizon: "day" | "swing" | null; prob: number | null };
}

const won = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n <= 0 ? "-" : `${Math.round(n).toLocaleString("ko-KR")}원`);
const pctS = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

function statOf(c: CalibRow | null, dirUp: boolean, ev?: Pick<ModelEval, "calib"> | null, where = "과거 비슷한 상황", minN = 20): string | null {
  // 해당 확률 구간 표본이 적으면(50건 미만) 같은 쪽 구간(≥55% 또는 ≤45%)을 합쳐서 보여 준다
  if (c && c.n < 50 && ev) {
    const side = ev.calib.filter((r) => (dirUp ? r.lo >= DAY_BUY_PROB : r.hi <= DAY_WEAK_PROB) && r.n > 0);
    const n = side.reduce((a, r) => a + r.n, 0);
    if (n >= c.n) {
      c = {
        lo: 0, hi: 1, n,
        upPct: side.reduce((a, r) => a + r.upPct * r.n, 0) / n,
        avgPct: side.reduce((a, r) => a + r.avgPct * r.n, 0) / n,
      };
    }
  }
  if (!c || c.n < minN) return null;
  const hit = dirUp ? c.upPct : 100 - c.upPct;
  return `${where} ${c.n.toLocaleString("ko-KR")}번 중 ${Math.round(hit)}%가 ${dirUp ? "올랐어요" : "밀렸어요"} (평균 ${pctS(c.avgPct, 2)})`;
}

function dayView(pred: Prediction, regime: RegimeView | null): ProbView | null {
  if (pred.dayProb == null) return null;
  const p = pred.dayProb;
  const up = p >= DAY_BUY_PROB;
  const down = p <= DAY_WEAK_PROB;
  // 같은 국면(출렁이는 장·상승 추세 등)의 검증 성적이 충분하면(같은 쪽 신호 50건 이상) 그걸 먼저 보여 준다
  let stat: string | null = null;
  const re = regime ? regimeEvalFor(pred.dayEval, regime.keys) : null;
  if (re && (up || down)) {
    const c = re.ev.calib.find((r) => p >= r.lo && p < r.hi) ?? null;
    stat = statOf(c, up, re.ev, `같은 ${REGIME_LABEL[re.key]}에서 비슷한 신호`, 50);
  }
  if (!stat) stat = up ? statOf(pred.dayCalib, true, pred.dayEval) : down ? statOf(pred.dayCalib, false, pred.dayEval) : null;
  return {
    prob: p,
    label: up ? "오늘 오를 가능성이 높아요" : down ? "오늘 밀릴 가능성이 높아요" : "오늘은 반반이에요",
    tone: up ? "up" : down ? "down" : "flat",
    stat,
    horizon: pred.checkpoint === "pre" ? "오늘 시가 → 종가" : "지금 → 오늘 종가",
    weak: false,
  };
}

function swingView(pred: Prediction, days: number): ProbView | null {
  if (pred.swingProb == null) return null;
  const p = pred.swingProb;
  const up = p >= 0.55;
  const down = p <= 0.45;
  return {
    prob: p,
    label: up ? "조금 유리" : down ? "조금 불리" : "반반",
    tone: up ? "up" : down ? "down" : "flat",
    stat: up ? statOf(pred.swingCalib, true, pred.swingEval) : down ? statOf(pred.swingCalib, false, pred.swingEval) : null,
    horizon: `${days}거래일 뒤`,
    weak: true,
  };
}

/** "강하게 말했을 때 맞힌 비율" — 성적표 표시용 (≥55%는 상승, <45%는 하락이 정답) */
export function hitRateOf(ev: ModelEval | null | undefined): { n: number; hitPct: number; naivePct: number } | null {
  if (!ev) return null;
  let n = 0, hit = 0, naive = 0;
  for (const r of ev.calib) {
    if (r.lo >= DAY_BUY_PROB) { n += r.n; hit += (r.n * r.upPct) / 100; naive += (r.n * ev.baseUpPct) / 100; }
    else if (r.hi <= DAY_WEAK_PROB) { n += r.n; hit += (r.n * (100 - r.upPct)) / 100; naive += (r.n * (100 - ev.baseUpPct)) / 100; }
  }
  // naivePct: 같은 날들에 근거 없이 "늘 오른다/늘 밀린다"로 찍었을 때 기대 적중률 (비교 기준)
  return n ? { n, hitPct: Math.round((hit / n) * 1000) / 10, naivePct: Math.round((naive / n) * 1000) / 10 } : null;
}

export function decide(params: {
  sig: EngineSignal;
  pred: Prediction;
  holding: { qty: number; avgPrice: number } | null;
  cash: number;
  totalAsset: number;
  /** 짝 종목과 합산 비중 한도까지 더 살 수 있는 금액 (반도체 두 종목 상관 0.89) */
  correlationHeadroom: number | null;
  phase: MarketPhaseInfo;
  dailyStopTriggered: boolean;
  swingDays: number;
  /** 시황 국면 (lib/regime.ts) — 국면별 성적 표시와 수량 조절에 쓴다 */
  regime?: RegimeView | null;
}): Decision {
  const { sig, pred, holding, phase } = params;
  const regime = params.regime ?? null;
  const price = sig.price;
  const day = dayView(pred, regime);
  const swing = swingView(pred, params.swingDays);
  const cp = pred.checkpoint;
  const inSession = ["장초반", "장중", "점심시간대", "마감임박", "동시호가"].includes(phase.phase);
  const p = pred.dayProb;
  const sigma = sig.volForecast?.available ? sig.volForecast.sigmaDailyPct : (pred.sigmaDailyPct ?? 2.5);

  const cautions: string[] = [];
  if (sig.priceLimits?.available && sig.priceLimits.beyondVi) cautions.push(`변동성 완화장치(VI) ${sig.priceLimits.beyondVi} 구간 — 2분간 단일가로 거래될 수 있어요`);
  if (sig.riskOverlay) cautions.push(sig.riskOverlay.notes[0]);
  const vfHigh = sig.volForecast?.available && (sig.volForecast.regime === "높음" || sig.volForecast.regime === "극단");
  if (vfHigh) cautions.push(`요즘 하루 평균 ±${sigma.toFixed(1)}% 움직여요 — 평소보다 크게 흔들리니 수량을 줄였어요`);
  // 이 국면에서 신호가 평소보다 덜 맞았으면 수량을 30% 줄인다 (맞힌 정도에 비례해 거는 원칙)
  const regimeWorse = regime?.edge?.better === false;

  const reasonsDay = pred.dayReasons.slice(0, 3);
  const base = { day, swing, cautions: cautions.slice(0, 2) };

  // 장이 닫혀 있으면 "지금 파세요"가 아니라 언제 팔지를 말한다
  const sellWhen = inSession ? "지금" : phase.phase === "장전" ? "9시에" : "다음 장에";
  const sellWhenLong = inSession ? "" : phase.phase === "장전" ? " 9시 장이 열리면 바로 정리하세요." : " 다음 거래일 9시 장이 열리면 정리하세요.";

  // ── 보유 중 ─────────────────────────────────────────────────────────────
  if (holding && holding.qty > 0 && holding.avgPrice > 0) {
    const pnl = (price / holding.avgPrice - 1) * 100;
    const stop = sig.stopPrice;
    const half = Math.max(1, Math.floor(holding.qty / 2));
    if (sig.action === "손절") {
      return {
        ...base,
        verdict: "stop_loss", title: `${sellWhen} 파세요`, tone: "danger",
        summary: inSession
          ? `손절선 아래로 내려왔어요(수익률 ${pctS(pnl)}). 원칙대로 정리하고 다음 기회를 기다리세요.`
          : `손절선 아래로 내려왔어요(수익률 ${pctS(pnl)}).${sellWhenLong}`,
        plan: [{ label: "팔 수량", value: `${holding.qty.toLocaleString("ko-KR")}주 전부` }, { label: "기준 손절가", value: won(stop) }],
        timing: null, reasons: [sig.warnings[0] ?? "손절 원칙"].filter(Boolean), claim: { dir: -1, horizon: "day", prob: p },
      };
    }
    if (sig.action === "전량매도") {
      return {
        ...base,
        verdict: "sell_all", title: inSession ? "전부 파세요" : `${sellWhen} 전부 파세요`, tone: "sell",
        summary: sig.reasons[0] ?? sig.warnings[0] ?? "신호가 크게 나빠졌어요.",
        plan: [{ label: "팔 수량", value: `${holding.qty.toLocaleString("ko-KR")}주 전부` }, { label: "지금 가격", value: won(price) }],
        timing: null, reasons: reasonsDay, claim: { dir: -1, horizon: "day", prob: p },
      };
    }
    if (sig.action === "부분매도") {
      return {
        ...base,
        verdict: "sell_half", title: inSession ? "절반 파세요" : `${sellWhen} 절반 파세요`, tone: "sell",
        summary: (sig.reasons[0] ?? "수익 일부를 챙길 자리예요.").split(" — ")[0],
        plan: [
          { label: "팔 수량", value: `${half.toLocaleString("ko-KR")}주 (절반)` },
          { label: "지금 가격", value: won(price), hint: `수익률 ${pctS(pnl)}` },
          { label: "남은 절반 손절가", value: won(stop) },
        ],
        timing: null, reasons: reasonsDay, claim: { dir: -1, horizon: "day", prob: p },
      };
    }
    // 그대로 보유 — 장중이면 "팔 거면 언제가 나은지" 타이밍만 알려 준다
    let timing: string | null = null;
    if (inSession && p != null && p <= DAY_WEAK_PROB) timing = "오늘 일부라도 파실 생각이면 종가보다 지금이 유리했어요";
    else if (inSession && p != null && p >= DAY_BUY_PROB) timing = "파실 생각이면 서두르지 마세요 — 오늘 종가까지 더 오른 경우가 많았어요";
    return {
      ...base,
      verdict: "hold", title: "그대로 두세요", tone: "hold",
      summary: `수익률 ${pctS(pnl)}. 손절가 ${won(stop)}만 지키면 됩니다.`,
      plan: [
        { label: "손절가", value: won(stop), hint: stop ? `지금보다 ${pctS((stop / price - 1) * 100)}` : undefined },
        { label: "평균 단가", value: won(holding.avgPrice) },
        { label: "본전 가격", value: won(sig.breakEvenPrice), hint: "세금·수수료 포함" },
      ],
      timing, reasons: reasonsDay, claim: { dir: 0, horizon: null, prob: p },
    };
  }

  // ── 미보유 ──────────────────────────────────────────────────────────────
  const waitWith = (summary: string, timing: string | null, reasons: string[] = reasonsDay): Decision => ({
    ...base,
    verdict: "wait", title: "기다리세요", tone: "wait", summary,
    plan: [], timing, reasons, claim: { dir: p != null && p <= DAY_WEAK_PROB && inSession ? -1 : 0, horizon: p != null && p <= DAY_WEAK_PROB && inSession ? "day" : null, prob: p },
  });

  if (params.dailyStopTriggered) return waitWith("오늘 계좌 손실이 한도(-3%)에 닿았어요. 오늘은 새로 사지 않는 날이에요.", null, []);
  if (sig.warnings.some((w) => w.startsWith("오늘 상한가") || w.startsWith("오늘 하한가"))) {
    return waitWith("상한가·하한가에 닿은 날이라 오늘은 쫓아 사지 않아요.", null, []);
  }
  if (!inSession && phase.phase !== "장전") {
    const next = phase.phase.startsWith("휴장") ? "다음 거래일 아침 8시 30분 이후" : "내일 아침 8시 30분 이후";
    return waitWith(`지금은 장이 닫혀 있어요. 미국장이 끝난 ${next}부터 그날 판단을 보여 드려요.`, null, []);
  }
  if (p == null) return waitWith("판단에 필요한 데이터를 아직 못 받았어요. 잠시 후 새로고침해 주세요.", null, []);

  if (p >= DAY_BUY_PROB && cp && MORNING.has(cp)) {
    // 수량: 1회 손실 ≤ 총자산 1%, 현금의 25% 이내, 변동성 클수록 축소, 짝 종목 합산 한도
    const stop = sig.stopPrice;
    const overheated = sig.warnings.some((w) => w.startsWith("추격 보정")) || (sig.intraday?.available === true && sig.intraday.distanceFromVwapPct > 2);
    const entry = overheated && sig.suggestedEntryPrice ? sig.suggestedEntryPrice : price;
    const stopDist = stop && entry > stop ? entry - stop : entry * 0.03;
    const volMult = sig.volForecast?.regime === "극단" ? 0.45 : sig.volForecast?.regime === "높음" ? 0.7 : sig.volForecast?.regime === "평온" ? 1.1 : 1;
    const regimeMult = regimeWorse ? 0.7 : 1;
    let budget = Math.min(params.cash * 0.25, (params.totalAsset * 0.01 * entry) / stopDist) * volMult * regimeMult * (sig.riskOverlay?.sizeMultiplier ?? 1);
    if (params.correlationHeadroom != null) budget = Math.min(budget, Math.max(0, params.correlationHeadroom));
    const qty = Math.floor(budget / entry);
    if (qty < 1) {
      return waitWith(
        params.cash < entry ? `오를 가능성은 높지만 현금(${won(params.cash)})이 1주 가격보다 적어요.` : "오를 가능성은 높지만 리스크 한도 안에서 살 수 있는 수량이 1주 미만이에요.",
        null,
      );
    }
    const dayTarget = roundToTick(entry * (1 + Math.max(sigma * 0.5, COST_PCT * 3) / 100), "KRW", "down", "KR");
    const isPre = cp === "pre";
    return {
      ...base,
      cautions: regimeWorse && regime?.edge
        ? [`${REGIME_LABEL[regime.edge.key]}에서는 이 신호가 평소보다 덜 맞아 수량을 30% 줄였어요`, ...base.cautions].slice(0, 2)
        : base.cautions,
      verdict: isPre ? "buy_open" : "buy_now",
      title: isPre ? "9시에 사세요" : overheated ? "지정가로 사세요" : "지금 사세요",
      tone: "buy",
      summary: isPre
        ? "오늘 장 시작 후 오를 가능성이 높아요. 시가 근처에서 사서 오늘 장 마감 전에 파는 단타예요."
        : overheated
          ? `오늘 오를 가능성은 높지만 지금은 많이 올라 있어요. ${won(entry)}에 지정가로 걸어 두세요.`
          : "오늘 종가까지 오를 가능성이 높아요. 사서 오늘 장 마감(15:20) 전에 파는 단타예요.",
      plan: [
        { label: "사는 가격", value: isPre ? "9시 시가 근처" : won(entry), hint: overheated ? "지정가 — 안 닿으면 오늘은 패스" : undefined },
        { label: "수량", value: `${qty.toLocaleString("ko-KR")}주`, hint: `약 ${won(qty * (isPre ? price : entry))}` },
        { label: "절반 익절", value: isPre ? `시가 +${Math.max(sigma * 0.5, 0.54).toFixed(1)}%` : won(dayTarget), hint: "닿으면 절반 팔기" },
        { label: "손절가", value: isPre ? `시가 -${((stopDist / entry) * 100).toFixed(1)}%` : won(stop), hint: "닿으면 바로 정리" },
        { label: "정리", value: "15:20 전 남은 수량 매도" },
      ],
      timing: null,
      reasons: reasonsDay,
      claim: { dir: 1, horizon: "day", prob: p },
    };
  }
  if (p >= DAY_BUY_PROB) {
    return waitWith("오늘 종가까지 조금 더 오를 가능성은 있지만, 오후 신호는 거래비용(0.18%)을 넘길 만큼 크지 않았어요.", null);
  }
  if (p <= DAY_WEAK_PROB) {
    return waitWith(
      "오늘은 장중에 밀릴 가능성이 높아요. 지금 사지 마세요.",
      inSession ? "며칠 들고 갈 생각으로 사실 거면 지금보다 장 마감 무렵(15:10~15:20)이 유리했어요" : null,
    );
  }
  return waitWith("오늘은 오를지 내릴지 뚜렷하지 않아요. 확실한 자리가 올 때까지 쉬어도 돼요.", null);
}
