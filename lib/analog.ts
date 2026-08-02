// 유사 패턴(아날로그) 예측 — "오늘과 가장 닮은 과거 날들은 그 다음에 어떻게 됐나"
//
// 기상청이 구름 이동을 예측할 때 쓰는 아날로그 기법과 같은 발상이다. 지금 상태를 숫자 벡터로
// 만들고, 과거 수천 개 날 중 가장 닮은 것들을 골라, 그 날들의 "실제 다음 날"을 모아 분포로 본다.
//
// 왜 필요한가: 기존 예상 경로(lib/forecastPath.ts)는 랜덤워크라 방향이 항상 "제자리"였다.
// 폭은 맞았지만("이만큼 움직일 수 있다") 매수·매도 판단에 직접 쓰기엔 부족하다. 아날로그는
// 방향과 크기를 함께 준다 — 다만 그 정확도를 반드시 실측해서 함께 보여줘야 한다.
//
// 정직성 원칙:
//  - 방향 적중률은 이 파일이 주장하지 않는다. scripts/validate-analog.ts가 워크포워드로
//    실측해 data/analog-stats.json에 저장하고, 엔진은 그 값을 읽어 쓴다.
//    (하드코딩하면 데이터가 바뀔 때 조용히 낡은 숫자를 말하게 된다 — 실제로 겪은 문제다)
//  - 미래 정보를 절대 쓰지 않는다. 후보 패턴은 조회 시점보다 과거인 것만 쓴다.
//  - 닮은 사례가 부족하거나 흩어져 있으면 "판단 보류"를 반환한다. 억지로 방향을 말하지 않는다.
import type { Candle, Indicators } from "./types";

// 특징 벡터의 각 축과 가중치.
// 가중치는 "이 변수가 다음날 방향과 얼마나 관련 있나"의 실측(scripts/validate-analog.ts의
// 변수별 기여도 측정)에 맞춰 정했다. 전일 SOX가 가장 크다 — 국내 반도체주는 같은 날짜 SOX보다
// 직전 미국장 SOX와 상관이 2배 강하다(0.33~0.43 vs 0.18~0.22).
export const FEATURE_SPEC = [
  { key: "ret1", label: "전일 등락", weight: 1.0 },
  { key: "ret3", label: "3일 누적", weight: 0.8 },
  { key: "ret5", label: "5일 누적", weight: 0.6 },
  { key: "rsi", label: "RSI(과매수·과매도)", weight: 0.9 },
  { key: "drawdown", label: "60일 고점 대비 낙폭", weight: 1.0 },
  { key: "maGap", label: "20일선 이격도", weight: 0.8 },
  { key: "volPct", label: "변동성 수준", weight: 0.9 },
  { key: "volumeZ", label: "거래량 급증도", weight: 0.7 },
  { key: "soxPrev", label: "간밤 미국 반도체지수(SOX)", weight: 1.4 },
  { key: "adx", label: "추세 강도(ADX)", weight: 0.5 },
] as const;

export type FeatureKey = (typeof FEATURE_SPEC)[number]["key"];
export type FeatureVector = Record<FeatureKey, number>;

export interface AnalogMatch {
  ticker: string;
  name: string;
  date: string;
  similarity: number; // 0~100 (100이 완전 동일)
  nextRetPct: number; // 그 날의 다음 거래일 종가 등락률
  nextOpenPct: number; // 다음날 시가 갭
  nextHighPct: number; // 다음날 고가 (종가 기준)
  nextLowPct: number; // 다음날 저가
}

export interface AnalogForecast {
  available: boolean;
  reason: string; // available=false일 때 왜 못 하는지
  poolSize: number; // 비교 대상이 된 과거 패턴 총 개수
  matched: number; // 그중 실제로 채택된 유사 사례 수
  avgSimilarity: number; // 채택된 사례들의 평균 유사도(0~100)
  bestMatch: AnalogMatch | null; // 가장 닮은 한 건 (사용자에게 "몇 번 패턴"으로 보여줄 근거)
  // 다음 거래일 전망 — 전부 유사 사례들의 실제 결과 분포에서 나온 값
  upProb: number; // 상승 마감 비율 (%)
  medianPct: number; // 등락률 중앙값
  p10Pct: number;
  p25Pct: number;
  p75Pct: number;
  p90Pct: number;
  // 하루 안의 움직임 모양 — 시간대별 상·하단을 그릴 때 쓴다
  medianOpenGapPct: number; // 시가 갭 중앙값
  medianHighPct: number; // 장중 고가 중앙값
  medianLowPct: number; // 장중 저가 중앙값
  gapUpProb: number; // 갭상승 출발 비율 (%)
  // 어떤 변수가 이 매칭을 이끌었나 (사용자에게 근거를 보여주기 위함)
  drivers: { label: string; value: string; contributionPct: number }[];
  features: FeatureVector;
}

/** 과거 패턴 하나 (풀에 담기는 단위) */
export interface AnalogPattern {
  ticker: string;
  name: string;
  date: string;
  f: FeatureVector;
  nextRetPct: number;
  nextOpenPct: number;
  nextHighPct: number;
  nextLowPct: number;
}

const MIN_MATCHES = 30; // 이보다 적으면 분포로 말할 수 없다
const TOP_K = 120; // 채택할 최근접 이웃 수 (풀 6천 개 기준 상위 2%)
const MIN_AVG_SIMILARITY = 55; // 평균 유사도가 이보다 낮으면 "닮은 날이 없다"로 본다

function ewmaSigmaPct(c: Candle[], t: number): number {
  const lambda = 0.94;
  let v = NaN;
  for (let i = Math.max(1, t - 200); i <= t; i++) {
    if (!(c[i - 1].close > 0 && c[i].close > 0)) continue;
    const r = Math.log(c[i].close / c[i - 1].close) * 100;
    v = isNaN(v) ? r * r : lambda * v + (1 - lambda) * r * r;
  }
  return Math.sqrt(Math.max(v, 1e-9));
}

function rsi14At(c: Candle[], t: number): number {
  if (t < 15) return 50;
  let up = 0;
  let down = 0;
  for (let i = t - 13; i <= t; i++) {
    const d = c[i].close - c[i - 1].close;
    if (d >= 0) up += d;
    else down -= d;
  }
  const rs = down === 0 ? 100 : up / down;
  return 100 - 100 / (1 + rs);
}

function adx14At(c: Candle[], t: number): number {
  // 단순화한 추세강도 — |20일 변화| ÷ (같은 기간 일변동 합) × 100. ADX와 같은 축(0~100)을 갖는다.
  if (t < 21) return 20;
  const net = Math.abs(c[t].close - c[t - 20].close);
  let path = 0;
  for (let i = t - 19; i <= t; i++) path += Math.abs(c[i].close - c[i - 1].close);
  return path > 0 ? Math.min(100, (net / path) * 100) : 20;
}

/**
 * 특징 벡터 계산. 전부 t 시점까지의 정보만 사용한다(미래 정보 없음).
 *
 * @param soxPrevRetPct 직전 미국장 SOX 등락률(%). 없으면 0으로 두되 그만큼 매칭 정확도가 떨어진다
 */
export function buildFeatures(c: Candle[], t: number, soxPrevRetPct: number): FeatureVector | null {
  if (t < 60 || !(c[t].close > 0)) return null;
  const sigma = ewmaSigmaPct(c, t);
  if (!(sigma > 0)) return null;
  const retN = (n: number) => (c[t - n]?.close > 0 ? ((c[t].close / c[t - n].close - 1) * 100) / (sigma * Math.sqrt(n)) : 0);

  const high60 = Math.max(...c.slice(t - 59, t + 1).map((x) => x.close));
  const ma20 = c.slice(t - 19, t + 1).reduce((a, x) => a + x.close, 0) / 20;
  const vols = c.slice(t - 19, t + 1).map((x) => x.volume);
  const vMean = vols.reduce((a, b) => a + b, 0) / vols.length;
  const vSd = Math.sqrt(vols.reduce((a, b) => a + (b - vMean) ** 2, 0) / vols.length);

  // 변동성 수준: 같은 종목의 과거 변동성 대비 지금 위치(0~100 분위)
  const past: number[] = [];
  for (let i = Math.max(220, t - 250); i < t; i += 5) {
    const s = ewmaSigmaPct(c, i);
    if (isFinite(s)) past.push(s);
  }
  const volPct = past.length ? (past.filter((x) => x < sigma).length / past.length) * 100 : 50;

  return {
    ret1: retN(1),
    ret3: retN(3),
    ret5: retN(5),
    rsi: (rsi14At(c, t) - 50) / 15, // 50을 0으로, 대략 ±1이 표준편차 수준
    drawdown: ((c[t].close / high60 - 1) * 100) / 12, // -12%를 -1로 (반도체주 통상 조정폭)
    maGap: ((c[t].close / ma20 - 1) * 100) / (sigma * 3),
    volPct: (volPct - 50) / 25,
    volumeZ: vSd > 0 ? Math.max(-3, Math.min(3, (c[t].volume - vMean) / vSd)) : 0,
    soxPrev: Math.max(-4, Math.min(4, soxPrevRetPct / 2)), // SOX 2%를 1단위로
    adx: (adx14At(c, t) - 25) / 15,
  };
}

/** 가중 유클리드 거리 → 0~100 유사도 */
function similarityOf(a: FeatureVector, b: FeatureVector): number {
  let sum = 0;
  let wsum = 0;
  for (const { key, weight } of FEATURE_SPEC) {
    const d = a[key] - b[key];
    sum += weight * d * d;
    wsum += weight;
  }
  const rms = Math.sqrt(sum / wsum);
  // rms 0 → 100점, rms 2(각 축 평균 2σ 차이) → 0점. 실측 분포상 상위 이웃은 대체로 60~90점.
  return Math.max(0, 100 * (1 - rms / 2));
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * 유사 패턴 검색 → 다음 거래일 전망.
 *
 * @param query 현재 상태의 특징 벡터
 * @param pool 비교 대상 과거 패턴들 (호출부가 "조회 시점보다 과거"만 담아야 한다)
 */
export function findAnalogs(query: FeatureVector, pool: AnalogPattern[]): AnalogForecast {
  const empty: AnalogForecast = {
    available: false,
    reason: "",
    poolSize: pool.length,
    matched: 0,
    avgSimilarity: 0,
    bestMatch: null,
    upProb: NaN,
    medianPct: NaN,
    p10Pct: NaN,
    p25Pct: NaN,
    p75Pct: NaN,
    p90Pct: NaN,
    medianOpenGapPct: NaN,
    medianHighPct: NaN,
    medianLowPct: NaN,
    gapUpProb: NaN,
    drivers: [],
    features: query,
  };
  if (pool.length < 300) return { ...empty, reason: "비교할 과거 패턴이 부족합니다" };

  const scored = pool
    .map((p) => ({ p, sim: similarityOf(query, p.f) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOP_K);

  if (scored.length < MIN_MATCHES) return { ...empty, reason: "닮은 과거 사례가 충분하지 않습니다" };
  const avgSim = scored.reduce((a, x) => a + x.sim, 0) / scored.length;
  if (avgSim < MIN_AVG_SIMILARITY) {
    return {
      ...empty,
      matched: scored.length,
      avgSimilarity: avgSim,
      reason: `지금 상태와 닮은 과거 날이 거의 없습니다(평균 유사도 ${avgSim.toFixed(0)}점) — 처음 보는 패턴이라 방향을 말하지 않습니다`,
    };
  }

  const rets = scored.map((x) => x.p.nextRetPct).sort((a, b) => a - b);
  const opens = scored.map((x) => x.p.nextOpenPct).sort((a, b) => a - b);
  const highs = scored.map((x) => x.p.nextHighPct).sort((a, b) => a - b);
  const lows = scored.map((x) => x.p.nextLowPct).sort((a, b) => a - b);

  // 어떤 변수가 이 매칭을 이끌었나 — 채택된 이웃들이 그 축에서 얼마나 "일치"했는지로 본다.
  // 축별 평균 제곱거리가 작을수록(=이웃들이 그 축에서 지금과 똑같을수록) 기여가 크다.
  const axisTightness = FEATURE_SPEC.map(({ key, label, weight }) => {
    const md = scored.reduce((a, x) => a + (query[key] - x.p.f[key]) ** 2, 0) / scored.length;
    return { key, label, score: weight / (0.25 + md), raw: query[key] };
  });
  const tightSum = axisTightness.reduce((a, x) => a + x.score, 0);
  const drivers = axisTightness
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => ({
      label: x.label,
      value: describeFeature(x.key as FeatureKey, x.raw),
      contributionPct: Math.round((x.score / tightSum) * 100),
    }));

  return {
    available: true,
    reason: "",
    poolSize: pool.length,
    matched: scored.length,
    avgSimilarity: avgSim,
    bestMatch: {
      ticker: scored[0].p.ticker,
      name: scored[0].p.name,
      date: scored[0].p.date,
      similarity: scored[0].sim,
      nextRetPct: scored[0].p.nextRetPct,
      nextOpenPct: scored[0].p.nextOpenPct,
      nextHighPct: scored[0].p.nextHighPct,
      nextLowPct: scored[0].p.nextLowPct,
    },
    upProb: (rets.filter((r) => r > 0).length / rets.length) * 100,
    medianPct: quantile(rets, 0.5),
    p10Pct: quantile(rets, 0.1),
    p25Pct: quantile(rets, 0.25),
    p75Pct: quantile(rets, 0.75),
    p90Pct: quantile(rets, 0.9),
    medianOpenGapPct: quantile(opens, 0.5),
    medianHighPct: quantile(highs, 0.5),
    medianLowPct: quantile(lows, 0.5),
    gapUpProb: (opens.filter((r) => r > 0).length / opens.length) * 100,
    drivers,
    features: query,
  };
}

/** 특징값을 사람이 읽는 문장으로 (분석 방식 탭에서 "무엇이 이 판단을 이끌었나"를 보여줄 때 씀) */
function describeFeature(key: FeatureKey, v: number): string {
  switch (key) {
    case "ret1":
      return v > 1 ? "전일 급등" : v < -1 ? "전일 급락" : "전일 보합권";
    case "ret3":
      return v > 0.8 ? "3일째 상승 흐름" : v < -0.8 ? "3일째 하락 흐름" : "3일간 방향 없음";
    case "ret5":
      return v > 0.8 ? "5일 누적 강세" : v < -0.8 ? "5일 누적 약세" : "5일간 횡보";
    case "rsi":
      return v > 1.3 ? "RSI 과매수권" : v < -1.3 ? "RSI 과매도권" : "RSI 중립";
    case "drawdown":
      return v < -2.5 ? "고점 대비 30%↓ 붕괴" : v < -1 ? "고점 대비 조정 중" : "고점 근처";
    case "maGap":
      return v > 1 ? "20일선 위로 크게 이격" : v < -1 ? "20일선 아래로 크게 이격" : "20일선 부근";
    case "volPct":
      return v > 1 ? "변동성 극단" : v < -1 ? "변동성 평온" : "변동성 보통";
    case "volumeZ":
      return v > 1.5 ? "거래량 폭증" : v < -1 ? "거래량 위축" : "거래량 평소 수준";
    case "soxPrev":
      return v > 1 ? "간밤 SOX 급등" : v < -1 ? "간밤 SOX 급락" : "간밤 SOX 보합";
    case "adx":
      return v > 1 ? "추세 강함" : v < -0.7 ? "횡보장" : "추세 보통";
  }
}

/** 일봉 배열에서 아날로그 패턴 풀을 만든다. soxByDate는 날짜→SOX 등락률(%). */
export function buildPatterns(
  ticker: string,
  name: string,
  c: Candle[],
  soxByDate: Map<string, number>,
): AnalogPattern[] {
  const out: AnalogPattern[] = [];
  for (let t = 60; t < c.length - 1; t++) {
    // 간밤 SOX = 국내 t일 "직전" 미국장 → 날짜상 t-1일 SOX (미국이 하루 늦게 마감하므로)
    const f = buildFeatures(c, t, soxByDate.get(c[t - 1].date) ?? 0);
    if (!f) continue;
    const cur = c[t].close;
    const nx = c[t + 1];
    if (!(cur > 0 && nx.close > 0 && nx.open > 0 && nx.high > 0 && nx.low > 0)) continue;
    out.push({
      ticker,
      name,
      date: c[t].date,
      f,
      nextRetPct: (nx.close / cur - 1) * 100,
      nextOpenPct: (nx.open / cur - 1) * 100,
      nextHighPct: (nx.high / cur - 1) * 100,
      nextLowPct: (nx.low / cur - 1) * 100,
    });
  }
  return out;
}

/** Indicators에서 특징 벡터를 만들 수 없을 때를 대비한 보조 — 엔진은 캔들을 그대로 넘긴다 */
export type { Indicators };
