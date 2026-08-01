// 장세 시나리오 분류 + 국면별 향후 수익률 분포 조회.
//
// 문제의식: "최근 6개월 보유 시 +63%" 같은 숫자는 여러 장세를 뭉갠 평균이라 미래 판단에 쓸 수
// 없다. 실제로 그 6개월에는 코스피가 2배 오른 강세장과, 고점 대비 40~60% 무너진 붕괴 국면이
// 함께 들어 있다. 강세장 평균을 붕괴 국면에 적용하면 정확히 반대로 판단하게 된다.
//
// 그래서 이 모듈은 (1) 지금이 어떤 국면인지 분류하고, (2) 과거 같은 국면에서 실제로 무슨 일이
// 있었는지 분포(중앙값·사분위·손실확률·급락확률)를 돌려준다. 예측이 아니라 조건부 기록이다.
//
// 분류 축 (모두 해당 시점까지의 정보만 사용 — 미래 정보 없음):
//  - 60일 고점 대비 낙폭: 상승 추세인지 붕괴 국면인지
//  - 변동성 분위: 같은 종목 과거 대비 지금 변동성이 어느 위치인지
//  - 60일 이동평균 상회 여부: 추세 방향
import type { Candle } from "./types";

export const SCENARIO_FWD_HORIZONS = [5, 20] as const;

export interface ScenarioStat {
  n: number;
  median: number;
  p25: number;
  p75: number;
  lossProb: number; // 하락 마감 확률 (%)
  crashProb: number; // -20% 이하 확률 (%)
  surgeProb: number; // +20% 이상 확률 (%)
}

export interface ScenarioTable {
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  universe: string;
  disclaimer: string;
  scenarios: Record<string, { d5?: ScenarioStat; d20?: ScenarioStat }>;
}

export interface ScenarioOutlook {
  available: boolean;
  label: string;
  drawdownPct: number; // 60일 고점 대비 (%)
  volPercentile: number; // 과거 대비 변동성 분위 (0~100)
  d5: ScenarioStat | null;
  d20: ScenarioStat | null;
  lowConfidence: boolean; // 표본 30 미만이면 true
  note: string;
}

function ewmaSigma(c: Candle[], t: number): number {
  const rs: number[] = [];
  for (let i = Math.max(1, t - 200); i <= t; i++) {
    if (c[i - 1].close > 0 && c[i].close > 0) rs.push(Math.log(c[i].close / c[i - 1].close) * 100);
  }
  if (rs.length < 20) return NaN;
  let v = rs.slice(0, 20).reduce((a, b) => a + b * b, 0) / 20;
  for (const r of rs) v = 0.94 * v + 0.06 * r * r;
  return Math.sqrt(v);
}

function movingAvg(c: Candle[], t: number, n: number): number {
  if (t < n - 1) return NaN;
  let s = 0;
  for (let i = t - n + 1; i <= t; i++) s += c[i].close;
  return s / n;
}

/** 해당 시점의 상태를 시나리오 라벨로 분류. 데이터가 부족하면 null. */
export function classifyScenario(candles: Candle[], t: number): string | null {
  if (t < 260 || t >= candles.length) return null;
  const high60 = Math.max(...candles.slice(t - 59, t + 1).map((x) => x.close));
  if (!(high60 > 0) || !(candles[t].close > 0)) return null;
  const dd = (candles[t].close / high60 - 1) * 100;
  const sg = ewmaSigma(candles, t);
  if (isNaN(sg)) return null;
  // 변동성 분위 — 자기 과거 250거래일 표본 대비
  const past: number[] = [];
  for (let i = Math.max(220, t - 250); i < t; i += 5) {
    const s = ewmaSigma(candles, i);
    if (!isNaN(s)) past.push(s);
  }
  const volPct = past.length ? (past.filter((x) => x < sg).length / past.length) * 100 : 50;
  const above = candles[t].close >= movingAvg(candles, t, 60);

  if (dd <= -35 && volPct >= 70) return "폭락바닥권(고점-35%↓·변동성극단)";
  if (dd <= -20 && volPct >= 70) return "고점붕괴초기(고점-20%↓·변동성급등)";
  if (dd <= -20) return "조정국면(고점-20%↓·변동성보통)";
  if (dd <= -10 && volPct >= 70) return "흔들리는상승(고점-10%↓·변동성높음)";
  if (above && volPct >= 70) return "고변동상승추세";
  if (above) return "안정상승추세";
  return "기타/횡보";
}

/** 현재 시점(캔들 마지막)의 시나리오와 과거 같은 국면의 향후 수익률 분포. */
export function computeScenarioOutlook(candles: Candle[], table: ScenarioTable | null): ScenarioOutlook {
  const empty: ScenarioOutlook = {
    available: false,
    label: "",
    drawdownPct: NaN,
    volPercentile: NaN,
    d5: null,
    d20: null,
    lowConfidence: true,
    note: "",
  };
  if (!table || candles.length < 261) return empty;
  const t = candles.length - 1;
  const label = classifyScenario(candles, t);
  if (!label) return empty;

  const high60 = Math.max(...candles.slice(t - 59, t + 1).map((x) => x.close));
  const drawdownPct = (candles[t].close / high60 - 1) * 100;
  const sg = ewmaSigma(candles, t);
  const past: number[] = [];
  for (let i = Math.max(220, t - 250); i < t; i += 5) {
    const s = ewmaSigma(candles, i);
    if (!isNaN(s)) past.push(s);
  }
  const volPercentile = past.length ? (past.filter((x) => x < sg).length / past.length) * 100 : NaN;

  const e = table.scenarios[label];
  const d5 = e?.d5 ?? null;
  const d20 = e?.d20 ?? null;
  const n = d20?.n ?? 0;
  const lowConfidence = n < 30;

  const note = d20
    ? `지금은 "${label}" 국면입니다(60일 고점 대비 ${drawdownPct.toFixed(0)}%). 과거 같은 국면 ${d20.n}회에서 20거래일 뒤 수익률은 중앙값 ${d20.median >= 0 ? "+" : ""}${d20.median}%, 넷 중 하나는 ${d20.p25}% 이하였고, 손실로 끝난 비율이 ${d20.lossProb}%였습니다.` +
      (d20.crashProb >= 10 ? ` 특히 ${d20.crashProb}%는 20% 넘게 더 빠졌습니다.` : "") +
      (lowConfidence ? " 다만 표본이 적어(30회 미만) 우연의 영향이 큽니다 — 방향을 확정하는 근거로 쓰지 마세요." : "")
    : `지금은 "${label}" 국면이지만 과거 표본이 없어 분포를 제시할 수 없습니다.`;

  return { available: true, label, drawdownPct, volPercentile, d5, d20, lowConfidence, note };
}
