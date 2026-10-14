// 삼성전자·SK하이닉스 전용 예측 모델 — "지금 사면 오늘 종가까지 / 3거래일 뒤 오를 확률".
//
// 학습·검증: scripts/train-model.ts (데이터: scripts/backfill-deep.ts → data/deep-history.json)
// 결과물:   data/model.json (계수 + 워크포워드 검증 성적표)
//
// 무엇을 보나 (2016~2026 일봉, 2023~2026 1시간봉, 2019~ 외국인·기관 수급으로 실측)
//  · 개장 무렵: 간밤 엔비디아·SOX가 크게 오른 날은 시가가 높게 뜬 뒤 장중에 밀리는 경우가 많았다
//    (엔비디아 전일 등락과 시가→종가 순위상관 2017~2026 열 해 모두 음수, 전체 -0.12).
//    전일 종가 위치·전일 장중 등락·최근 5일 급등락도 같은 방향(되돌림)이었다.
//  · 10시 이후: 반대로 "오늘 시가 대비 위치·당일 고저 중 위치"가 강할수록 종가까지 더 오르는
//    장중 추세가 있었다(남은 시간 수익률과 순위상관 +0.05~+0.12).
//  · 며칠(3거래일): 사실상 예측되지 않는다(검증 AUC 0.53, 연도별 0.46~0.57). 화면에서도 "근거 약함"으로
//    표시하고 매수·매도 판단에는 쓰지 않는다. 대신 검증된 "언제 사고팔지"(시가 vs 오후) 타이밍만 안내한다.
// 모든 숫자는 워크포워드(과거로만 학습 → 그 뒤 기간에 적용)로 잰 값이며 data/model.json 에 남는다.
import type { Candle } from "./types";

export type Checkpoint = "open" | "h10" | "h11" | "h12" | "h13" | "h14" | "h15";
export const CHECKPOINTS: Checkpoint[] = ["open", "h10", "h11", "h12", "h13", "h14", "h15"];

export const OPEN_FEATURES = ["nvdaZ", "soxZ", "gapZ", "clvPrev", "ocPrevZ", "ret5Z", "pairRel5Z"] as const;
export const HOUR_FEATURES = ["since", "rangePos", "gapZ", "nvdaZ", "clvPrev", "ret5Z"] as const;
// 스윙(3거래일) — 수급(외국인·기관 5일)은 넣어 봤지만 검증 성적이 오히려 나빠져(AUC 0.505) 뺐다.
export const SWING_FEATURES = ["clv", "ocZ", "ret5Zc", "ret20Zc", "pairRel5Z"] as const;

// frgn5·inst5 는 모델에는 안 쓰지만 화면 표시(외국인·기관 5일 순매수)용으로 계산해 둔다
export type FeatureName = (typeof OPEN_FEATURES)[number] | (typeof HOUR_FEATURES)[number] | (typeof SWING_FEATURES)[number] | "frgn5" | "inst5";
export type Features = Partial<Record<FeatureName, number>>;

/** 로지스틱 모델 하나 — 특징은 ±3으로 자른 뒤 선형결합 */
export interface LogitModel {
  features: string[];
  coef: number[];
  intercept: number;
}

/** 확률 구간별 실제 성적 (워크포워드 검증에서 나온 값) */
export interface CalibRow {
  lo: number; // 구간 하한(포함)
  hi: number; // 구간 상한(미포함)
  n: number;
  upPct: number; // 실제로 오른 비율 %
  avgPct: number; // 평균 등락 %
}
export interface ModelEval {
  n: number;
  auc: number;
  ic: number;
  baseUpPct: number; // 기저 상승 비율 (아무것도 안 보고 "오른다"라고 했을 때)
  period: string; // 검증 기간
  calib: CalibRow[];
  byYear?: { year: string; n: number; auc: number }[];
}
export interface TwoStockModel {
  generatedAt: string;
  dataRange: { daily: string; hourly: string; flows: string };
  day: Record<Checkpoint, LogitModel & { eval: ModelEval }>;
  swing: LogitModel & { eval: ModelEval; horizonDays: number };
  /** 장 시작 전: 간밤 미국 등락으로 갭(σ 단위)을 추정하는 선형식 — gapZ ≈ a·nvdaZ + b·soxZ + c */
  preGap: { nvda: number; sox: number; c: number };
  /** 최근 미국 지수 일간 변동성(60일 σ, %) — 실시간 σ를 못 구할 때 쓰는 대체값 */
  usSigmaFallback: { nvda: number; sox: number };
}

export const clip3 = (x: number) => Math.max(-3, Math.min(3, x));

export function logitProb(m: LogitModel, f: Features): number | null {
  let z = m.intercept;
  for (let i = 0; i < m.features.length; i++) {
    const v = f[m.features[i] as FeatureName];
    if (v == null || !Number.isFinite(v)) return null;
    z += m.coef[i] * clip3(v);
  }
  return 1 / (1 + Math.exp(-z));
}

/** 각 특징이 확률을 어느 쪽으로 얼마나 밀었는지 (로짓 기여도) — 화면의 "이유" 문장에 쓴다 */
export function contributions(m: LogitModel, f: Features): { name: string; value: number; contrib: number }[] {
  return m.features
    .map((name, i) => {
      const v = f[name as FeatureName];
      return { name, value: v ?? NaN, contrib: v != null && Number.isFinite(v) ? m.coef[i] * clip3(v) : 0 };
    })
    .sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
}

// ── 특징 계산 (학습과 실시간이 같은 함수를 쓴다) ─────────────────────────────────────────

function stdev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}

/** 완성 일봉 종가 배열의 최근 n일 일간 등락률 σ(%) */
export function dailySigmaPct(closes: number[], n = 20): number {
  if (closes.length < n + 1) return NaN;
  const rets: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) rets.push((closes[i] / closes[i - 1] - 1) * 100);
  return stdev(rets);
}

export interface PriorDays {
  /** 판단일 "전날까지" 완성된 일봉 (마지막 = 전 거래일) */
  candles: Candle[];
  /** 같은 기간 짝 종목(삼성↔하이닉스)의 완성 일봉 */
  pairCandles: Candle[];
  /** 전날까지 외국인·기관 일별 순매수(주) — 최근 것이 마지막 */
  flows?: { d?: string; foreign: number; inst: number }[];
}

export interface Overnight {
  nvdaPct: number | null; // 직전 미국 정규장 등락률 %
  soxPct: number | null;
  nvdaSigma: number | null; // 미국 60일 σ %
  soxSigma: number | null;
}

export interface Intraday {
  open: number;
  high: number; // 지금까지 고가
  low: number; // 지금까지 저가
  price: number; // 현재가
}

/** 일봉에서 나오는 공통 특징 (판단일 아침에 이미 아는 값) */
export function priorFeatures(pd: PriorDays, on: Overnight): { f: Features; sigma: number; prevClose: number } | null {
  const c = pd.candles;
  if (c.length < 25) return null;
  const closes = c.map((x) => x.close);
  const sigma = dailySigmaPct(closes, 20);
  if (!(sigma > 0)) return null;
  const last = c[c.length - 1];
  const f: Features = {};
  f.clvPrev = last.high > last.low ? Math.max(-1, Math.min(1, (last.close - last.low - (last.high - last.close)) / (last.high - last.low))) : 0;
  f.ocPrevZ = ((last.close / last.open - 1) * 100) / sigma;
  const r5 = (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100;
  f.ret5Z = r5 / (sigma * Math.sqrt(5));
  const pc = pd.pairCandles.map((x) => x.close);
  if (pc.length >= 6) {
    const pr5 = (pc[pc.length - 1] / pc[pc.length - 6] - 1) * 100;
    f.pairRel5Z = (r5 - pr5) / sigma;
  }
  if (on.nvdaPct != null && on.nvdaSigma && on.nvdaSigma > 0) f.nvdaZ = on.nvdaPct / on.nvdaSigma;
  if (on.soxPct != null && on.soxSigma && on.soxSigma > 0) f.soxZ = on.soxPct / on.soxSigma;
  // 수급: 최근 5일 합 ÷ 20일 평균 거래량 (%), ±300 자른 뒤 /100
  const vols = c.slice(-20).map((x) => x.volume).filter((v) => v > 0);
  const avgVol = vols.length >= 10 ? vols.reduce((a, b) => a + b, 0) / vols.length : NaN;
  if (pd.flows && pd.flows.length >= 5 && avgVol > 0) {
    const last5 = pd.flows.slice(-5);
    const sum = (k: "foreign" | "inst") => last5.reduce((a, x) => a + x[k], 0);
    f.frgn5 = Math.max(-300, Math.min(300, (sum("foreign") / avgVol) * 100)) / 100;
    f.inst5 = Math.max(-300, Math.min(300, (sum("inst") / avgVol) * 100)) / 100;
  } else {
    f.frgn5 = 0;
    f.inst5 = 0;
  }
  return { f, sigma, prevClose: last.close };
}

/** 장중 특징 — 현재가를 "지금 시점의 종가"로 본다 */
export function intradayFeatures(base: Features, sigma: number, prevClose: number, closes: number[], id: Intraday): Features {
  const f: Features = { ...base };
  f.gapZ = ((id.open / prevClose - 1) * 100) / sigma;
  f.since = ((id.price / id.open - 1) * 100) / sigma;
  const hi = Math.max(id.high, id.open, id.price);
  const lo = Math.min(id.low, id.open, id.price);
  f.rangePos = hi > lo ? ((id.price - lo) / (hi - lo) - 0.5) * 2 : 0;
  // 스윙(종가 판단) 특징을 지금 가격으로 근사
  f.clv = hi > lo ? Math.max(-1, Math.min(1, (id.price - lo - (hi - id.price)) / (hi - lo))) : 0;
  f.ocZ = f.since;
  const n = closes.length;
  if (n >= 20) {
    f.ret5Zc = ((id.price / closes[n - 5] - 1) * 100) / (sigma * Math.sqrt(5));
    f.ret20Zc = ((id.price / closes[n - 20] - 1) * 100) / (sigma * Math.sqrt(20));
  }
  return f;
}

/** KST 시각(분) → 어떤 시점 모델을 쓸지. 장전이면 "open"(갭은 추정), 장 마감 후면 null(단타 없음) */
export function checkpointFor(kstMinutes: number): Checkpoint | "pre" | null {
  const open = 9 * 60;
  if (kstMinutes < open) return "pre";
  if (kstMinutes >= 15 * 60 + 30) return null;
  if (kstMinutes < open + 20) return "open";
  const h = Math.round(kstMinutes / 60);
  const hh = Math.max(10, Math.min(15, h));
  return `h${hh}` as Checkpoint;
}

export interface Prediction {
  available: boolean;
  checkpoint: Checkpoint | "pre" | null;
  /** 지금 사면 오늘 종가에 오를 확률 (장 마감 후면 null) */
  dayProb: number | null;
  /** 지금(또는 종가에) 사서 3거래일 뒤 오를 확률 */
  swingProb: number | null;
  /** 과거 비슷한 확률 구간의 실제 성적 */
  dayCalib: CalibRow | null;
  swingCalib: CalibRow | null;
  dayEval: ModelEval | null;
  swingEval: ModelEval | null;
  /** 확률을 움직인 상위 이유 (사람 말) */
  dayReasons: string[];
  swingReasons: string[];
  features: Features;
  sigmaDailyPct: number | null;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

/** 특징 하나를 사람 말로 — 확률을 올렸는지 내렸는지(dir)에 맞춰 */
function describe(name: string, f: Features, sigma: number, on: Overnight, up: boolean): string | null {
  const arrow = up ? "유리" : "불리";
  switch (name) {
    case "nvdaZ":
      return on.nvdaPct != null ? `간밤 엔비디아 ${pct(on.nvdaPct)} — ${on.nvdaPct >= 0 ? "높게 시작한 날은 장중에 밀린 경우가 많았어요" : "낮게 시작한 날은 장중에 회복한 경우가 많았어요"} (${arrow})` : null;
    case "soxZ":
      return on.soxPct != null ? `간밤 미국 반도체지수 ${pct(on.soxPct)} (${arrow})` : null;
    case "gapZ": {
      const g = (f.gapZ ?? 0) * sigma;
      return `오늘 시가 ${pct(g)} 출발 (${arrow})`;
    }
    case "clvPrev":
      return (f.clvPrev ?? 0) <= -0.3 ? `어제 저가 근처에서 마감 — 다음날 반등이 많았던 자리 (${arrow})` : (f.clvPrev ?? 0) >= 0.3 ? `어제 고가 근처에서 마감 — 다음날 밀린 경우가 많았던 자리 (${arrow})` : null;
    case "ocPrevZ": {
      const v = (f.ocPrevZ ?? 0) * sigma;
      return `어제 장중 ${pct(v)} (${arrow})`;
    }
    case "ret5Z": {
      const v = (f.ret5Z ?? 0) * sigma * Math.sqrt(5);
      return `최근 5일 ${pct(v)} (${arrow})`;
    }
    case "pairRel5Z":
      return `짝 종목보다 최근 5일 ${(f.pairRel5Z ?? 0) >= 0 ? "더 올랐어요" : "덜 올랐어요"} (${arrow})`;
    case "since": {
      const v = (f.since ?? 0) * sigma;
      return `시가 대비 ${pct(v)} — ${v >= 0 ? "오전에 강한 날은 오후에도 이어진 경우가 많았어요" : "오전에 약한 날은 오후에도 약한 경우가 많았어요"} (${arrow})`;
    }
    case "rangePos": {
      const r = ((f.rangePos ?? 0) + 1) / 2;
      return `오늘 고가·저가 사이 ${r >= 0.66 ? "위쪽" : r <= 0.33 ? "아래쪽" : "가운데"}에 있어요 (${arrow})`;
    }
    case "clv":
      return `가격이 그날 ${(f.clv ?? 0) >= 0.3 ? "고가" : (f.clv ?? 0) <= -0.3 ? "저가" : "고가·저가 중간"} 근처 (${arrow})`;
    case "ocZ":
      return null; // since 와 같은 값 — 중복 설명 생략
    case "ret5Zc": {
      const v = (f.ret5Zc ?? 0) * sigma * Math.sqrt(5);
      return `5거래일 전보다 ${pct(v)} (${arrow})`;
    }
    case "ret20Zc": {
      const v = (f.ret20Zc ?? 0) * sigma * Math.sqrt(20);
      return `한 달(20거래일) 전보다 ${pct(v)} (${arrow})`;
    }
    case "inst5":
      return (f.inst5 ?? 0) !== 0 ? `기관 최근 5일 ${(f.inst5 ?? 0) > 0 ? "순매수" : "순매도"} (${arrow})` : null;
    case "frgn5":
      return (f.frgn5 ?? 0) !== 0 ? `외국인 최근 5일 ${(f.frgn5 ?? 0) > 0 ? "순매수" : "순매도"} (${arrow})` : null;
    default:
      return null;
  }
}

function reasonsFor(m: LogitModel, f: Features, sigma: number, on: Overnight, max = 3): string[] {
  const out: string[] = [];
  for (const c of contributions(m, f)) {
    if (Math.abs(c.contrib) < 0.03) break; // 의미 없는 크기는 말하지 않는다
    const s = describe(c.name, f, sigma, on, c.contrib > 0);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function calibFor(ev: ModelEval | null | undefined, p: number | null): CalibRow | null {
  if (!ev || p == null) return null;
  return ev.calib.find((r) => p >= r.lo && p < r.hi) ?? null;
}

/**
 * 실시간 예측. model 이 없거나 일봉이 부족하면 available=false.
 *
 * candles 에는 오늘 봉이 들어 있을 수도 있다(장 마감 후 dropInProgressCandle 이 남긴다). 학습과 같은
 * 정의를 지키려고 "오늘 이전" 봉만 과거로 쓰고, 오늘 봉은 장중 상황(intraday)으로 다룬다.
 *  · 장전: 단타는 개장 모델 + 간밤 미국 등락으로 추정한 갭, 스윙은 전일 종가 기준
 *  · 장중: 시점별(10~15시) 모델, 스윙은 현재가를 "오늘 종가"로 보고 계산
 *  · 장 마감 후: 단타 없음, 스윙은 오늘 종가 기준
 *  · 휴장일: 단타 없음, 스윙은 마지막 거래일 종가 기준
 */
export function predict(params: {
  model: TwoStockModel | null;
  candles: Candle[];
  pairCandles: Candle[];
  flows?: { d: string; foreign: number; inst: number }[];
  overnight: Overnight;
  intraday: Intraday | null;
  kstMinutes: number;
  todayKst: string; // YYYY-MM-DD
  marketOpenToday: boolean; // 오늘이 거래일인가 (주말·휴장이면 false)
}): Prediction {
  const empty: Prediction = {
    available: false, checkpoint: null, dayProb: null, swingProb: null, dayCalib: null, swingCalib: null,
    dayEval: null, swingEval: null, dayReasons: [], swingReasons: [], features: {}, sigmaDailyPct: null,
  };
  const { model } = params;
  if (!model) return empty;
  const on: Overnight = {
    ...params.overnight,
    nvdaSigma: params.overnight.nvdaSigma ?? model.usSigmaFallback.nvda,
    soxSigma: params.overnight.soxSigma ?? model.usSigmaFallback.sox,
  };
  const today = params.marketOpenToday ? params.todayKst : "9999-99-99";
  const prior = params.candles.filter((c) => c.date < today);
  const pairPrior = params.pairCandles.filter((c) => c.date < today);
  const todayBar = params.marketOpenToday ? params.candles.find((c) => c.date === params.todayKst) : undefined;
  const flows = (params.flows ?? []).filter((x) => x.d < today);
  let intraday = params.intraday;
  if (!intraday && todayBar) intraday = { open: todayBar.open, high: todayBar.high, low: todayBar.low, price: todayBar.close };

  const pf = priorFeatures({ candles: prior, pairCandles: pairPrior, flows }, on);
  if (!pf) return empty;
  const closes = prior.map((c) => c.close);
  const cp = params.marketOpenToday ? checkpointFor(params.kstMinutes) : null;

  let f: Features;
  if (intraday && cp !== "pre" && params.marketOpenToday) {
    // 장중(또는 장 마감 후 오늘 봉): 현재가 = 지금 시점의 종가
    f = intradayFeatures(pf.f, pf.sigma, pf.prevClose, closes, intraday);
  } else {
    // 장전·휴장: 마지막 거래일을 "그날 종가 판단" 시점으로 본다 (스윙 특징), 단타 특징은 아래에서 따로
    const last = prior[prior.length - 1];
    const before = closes.slice(0, -1);
    const sig2 = dailySigmaPct(before, 20) || pf.sigma;
    const sf = intradayFeatures(pf.f, sig2, before[before.length - 1] ?? last.open, before, {
      open: last.open, high: last.high, low: last.low, price: last.close,
    });
    f = { ...pf.f, clv: sf.clv, ocZ: sf.ocZ, ret5Zc: sf.ret5Zc, ret20Zc: sf.ret20Zc };
  }

  let dayProb: number | null = null;
  let dayModel: (LogitModel & { eval: ModelEval }) | null = null;
  let dayF = f;
  if (cp === "pre") {
    // 시가를 모르니 간밤 미국 등락으로 갭을 추정해 개장 모델에 넣는다
    const g = model.preGap;
    dayF = { ...f, gapZ: g.nvda * (f.nvdaZ ?? 0) + g.sox * (f.soxZ ?? 0) + g.c };
    dayModel = model.day.open;
  } else if (cp && intraday) {
    dayModel = model.day[cp];
  }
  if (dayModel) dayProb = logitProb(dayModel, dayF);
  const swingProb = logitProb(model.swing, f);

  return {
    available: dayProb != null || swingProb != null,
    checkpoint: cp,
    dayProb,
    swingProb,
    dayCalib: calibFor(dayModel?.eval, dayProb),
    swingCalib: calibFor(model.swing.eval, swingProb),
    dayEval: dayModel?.eval ?? null,
    swingEval: model.swing.eval,
    dayReasons: dayModel ? reasonsFor(dayModel, dayF, pf.sigma, on) : [],
    swingReasons: reasonsFor(model.swing, f, pf.sigma, on),
    features: f,
    sigmaDailyPct: pf.sigma,
  };
}

// ── 학습 도구 (scripts/train-model.ts 와 검증 스크립트가 쓴다) ─────────────────────────

/** L2 로지스틱 회귀 (뉴턴법). 목적함수 = Σ로그손실 + (1/2C)·|w|² — sklearn C 와 같은 정의 */
export function fitLogit(X: number[][], y: number[], C = 0.1, iters = 25): { coef: number[]; intercept: number } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const w = new Array(d + 1).fill(0); // 마지막 = 절편
  const lam = 1 / C;
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0);
    const Hm = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const xi = [...X[i].map(clip3), 1];
      let z = 0;
      for (let j = 0; j <= d; j++) z += w[j] * xi[j];
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const e = p - y[i];
      const s = p * (1 - p);
      for (let j = 0; j <= d; j++) {
        g[j] += e * xi[j];
        for (let k = 0; k <= d; k++) Hm[j][k] += s * xi[j] * xi[k];
      }
    }
    for (let j = 0; j < d; j++) {
      g[j] += lam * w[j];
      Hm[j][j] += lam;
    }
    const step = solve(Hm, g);
    let maxStep = 0;
    for (let j = 0; j <= d; j++) {
      w[j] -= step[j];
      maxStep = Math.max(maxStep, Math.abs(step[j]));
    }
    if (maxStep < 1e-8) break;
  }
  return { coef: w.slice(0, d), intercept: w[d] };
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (M[i][i] || 1e-12));
}

export function aucOf(p: number[], y: number[]): number {
  const idx = p.map((v, i) => [v, y[i]] as [number, number]).sort((a, b) => a[0] - b[0]);
  let rank = 0, sumPos = 0, nPos = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (idx[k][1] === 1) { sumPos += r; nPos++; }
    rank = j + 1;
    i = j + 1;
  }
  const nNeg = idx.length - nPos;
  void rank;
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : 0.5;
}

export function spearman(a: number[], b: number[]): number {
  const rk = (v: number[]) => {
    const s = v.map((x, i) => [x, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < s.length; ) {
      let j = i;
      while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++;
      for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rk(a), rb = rk(b);
  const m = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
  const ma = m(ra), mb = m(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export const CALIB_EDGES = [0, 0.4, 0.45, 0.5, 0.55, 0.6, 1.0001];
export function calibrate(p: number[], ret: number[]): CalibRow[] {
  const rows: CalibRow[] = [];
  for (let i = 0; i < CALIB_EDGES.length - 1; i++) {
    const lo = CALIB_EDGES[i], hi = CALIB_EDGES[i + 1];
    const sel = p.map((v, k) => (v >= lo && v < hi ? ret[k] : null)).filter((v): v is number => v != null);
    rows.push({
      lo, hi, n: sel.length,
      upPct: sel.length ? Math.round((sel.filter((v) => v > 0).length / sel.length) * 1000) / 10 : 0,
      avgPct: sel.length ? Math.round((sel.reduce((a, b) => a + b, 0) / sel.length) * 100) / 100 : 0,
    });
  }
  return rows;
}
