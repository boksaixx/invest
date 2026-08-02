// 상승 확률 모델 검증 — "오늘 오를 확률 몇 %"를 말할 자격이 있는지 판정한다.
//
// 실행: npx tsx scripts/validate-probability.ts
//
// 배경: 1차 시도(scripts/validate-analog.ts)는 단일 시간대 특징 + 단순 kNN이었고 실패했다
// (적중률 47.4% < 기준선 54.2%). 그 원인이 "방향은 원래 예측 불가"인지 "모델이 단조로웠는지"를
// 가르기 위해, 이번에는 다중 시간대 + 인과 요인 + 여러 모델 계열을 한꺼번에 비교한다.
//
// 시간대: 3일 / 1주 / 2주 / 1개월 / 6개월 / 3년 — 각각 다른 성격의 정보를 담는다.
//   짧은 구간은 되돌림(평균회귀), 긴 구간은 추세와 국면을 나타낸다.
//
// 판정 기준은 적중률이 아니라 **Brier score**(확률 예측의 표준 지표)다.
//   Brier = 평균((예측확률 - 실제결과)²). 낮을수록 좋다.
//   "항상 기저율을 말하는" 모델을 못 이기면, 그 모델은 정보가 없는 것이다.
// 함께 보는 것:
//   - 신뢰도(calibration): 60%라고 말한 날 중 실제로 60%가 올랐나. 이게 맞아야 확률을 표시할 수 있다.
//   - AUC: 오른 날과 내린 날을 순서대로 가를 수 있나 (0.5 = 무작위)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../lib/types";

const KR = [
  { sym: "005930.KS", label: "삼성전자" },
  { sym: "000660.KS", label: "SK하이닉스" },
  { sym: "009150.KS", label: "삼성전기" },
  { sym: "042700.KS", label: "한미반도체" },
  { sym: "000990.KS", label: "DB하이텍" },
];
const TRAIN_MIN = 300; // 이 인덱스 이전은 특징 계산용으로만 쓴다
const EVAL_DAYS = 750; // 최근 3년가량을 평가 구간으로 (표본을 넉넉히)

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

/** 다중 시간대 특징 — 전부 t 시점까지의 정보만 사용 */
export interface MultiFeatures {
  ret3d: number; // 3일 수익률 (자기 변동성으로 정규화)
  ret1w: number;
  ret2w: number;
  ret1m: number;
  ret6m: number;
  ret3y: number;
  volRatio: number; // 최근 변동성 ÷ 장기 변동성 (국면)
  drawdown: number; // 60일 고점 대비
  maStruct: number; // 20일선 대비 이격 (추세 위치)
  rsi: number;
  volumeZ: number;
  soxPrev: number; // 간밤 미 반도체지수
  kospiPrev: number; // 전일 코스피 (시장 전체 흐름)
}

function sigmaOf(c: Candle[], t: number, win: number): number {
  const rs: number[] = [];
  for (let i = Math.max(1, t - win + 1); i <= t; i++) {
    if (c[i - 1].close > 0 && c[i].close > 0) rs.push(Math.log(c[i].close / c[i - 1].close));
  }
  if (rs.length < 5) return NaN;
  return Math.sqrt(rs.reduce((a, b) => a + b * b, 0) / rs.length);
}

function rsi14(c: Candle[], t: number): number {
  if (t < 15) return 50;
  let up = 0;
  let dn = 0;
  for (let i = t - 13; i <= t; i++) {
    const d = c[i].close - c[i - 1].close;
    if (d >= 0) up += d;
    else dn -= d;
  }
  return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
}

export function buildMultiFeatures(
  c: Candle[],
  t: number,
  soxPrevPct: number,
  kospiPrevPct: number,
): MultiFeatures | null {
  if (t < 260 || !(c[t].close > 0)) return null;
  const sd = sigmaOf(c, t, 60);
  if (!(sd > 0)) return null;
  // 각 구간 수익률을 "그 구간에서 기대되는 변동폭"으로 나눠 시간대끼리 비교 가능하게 만든다
  const norm = (n: number) => {
    const p0 = c[Math.max(0, t - n)]?.close;
    if (!(p0 > 0)) return 0;
    return Math.log(c[t].close / p0) / (sd * Math.sqrt(n));
  };
  const high60 = Math.max(...c.slice(t - 59, t + 1).map((x) => x.close));
  const ma20 = c.slice(t - 19, t + 1).reduce((a, x) => a + x.close, 0) / 20;
  const vols = c.slice(t - 19, t + 1).map((x) => x.volume);
  const vm = vols.reduce((a, b) => a + b, 0) / vols.length;
  const vsd = Math.sqrt(vols.reduce((a, b) => a + (b - vm) ** 2, 0) / vols.length);
  const longSd = sigmaOf(c, t, 250);

  return {
    ret3d: norm(3),
    ret1w: norm(5),
    ret2w: norm(10),
    ret1m: norm(21),
    ret6m: norm(122),
    ret3y: norm(Math.min(750, t)),
    volRatio: longSd > 0 ? sigmaOf(c, t, 20) / longSd - 1 : 0,
    drawdown: (c[t].close / high60 - 1) / 0.12,
    maStruct: (c[t].close / ma20 - 1) / (sd * 3),
    rsi: (rsi14(c, t) - 50) / 15,
    volumeZ: vsd > 0 ? Math.max(-3, Math.min(3, (c[t].volume - vm) / vsd)) : 0,
    soxPrev: Math.max(-4, Math.min(4, soxPrevPct / 2)),
    kospiPrev: Math.max(-4, Math.min(4, kospiPrevPct / 1.2)),
  };
}

const KEYS: (keyof MultiFeatures)[] = [
  "ret3d", "ret1w", "ret2w", "ret1m", "ret6m", "ret3y",
  "volRatio", "drawdown", "maStruct", "rsi", "volumeZ", "soxPrev", "kospiPrev",
];

/** 로지스틱 회귀 (경사하강) — 온라인 학습이 아니라 워크포워드로 매번 과거만 써서 새로 적합 */
function fitLogistic(X: number[][], y: number[], iters = 300, lr = 0.08, l2 = 0.02): number[] {
  const n = X.length;
  const d = X[0].length;
  const w = new Array(d + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let z = w[d];
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const e = p - y[i];
      for (let j = 0; j < d; j++) g[j] += e * X[i][j];
      g[d] += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
    w[d] -= lr * (g[d] / n);
  }
  return w;
}
const predictLogistic = (w: number[], x: number[]) => {
  let z = w[w.length - 1];
  for (let j = 0; j < x.length; j++) z += w[j] * x[j];
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
};

function brier(preds: number[], ys: number[]): number {
  return preds.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / preds.length;
}
function auc(preds: number[], ys: number[]): number {
  const pos = preds.filter((_, i) => ys[i] === 1);
  const neg = preds.filter((_, i) => ys[i] === 0);
  if (!pos.length || !neg.length) return 0.5;
  let win = 0;
  for (const p of pos) for (const n of neg) win += p > n ? 1 : p === n ? 0.5 : 0;
  return win / (pos.length * neg.length);
}

function main() {
  const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;
  const pctMap = (sym: string) => {
    const m = new Map<string, number>();
    const c = hist.symbols[sym]?.candles ?? [];
    for (let i = 1; i < c.length; i++) if (c[i - 1].close > 0 && c[i].close > 0) m.set(c[i].date, (c[i].close / c[i - 1].close - 1) * 100);
    return m;
  };
  const sox = pctMap("^SOX");
  const kospi = pctMap("^KS11");
  const prevDay = (d: string) => {
    const x = new Date(d);
    x.setDate(x.getDate() - 1);
    return x.toISOString().slice(0, 10);
  };

  // 전체 표본 수집 (종목·날짜)
  type Row = { date: string; x: number[]; y: number; ret: number };
  const rows: Row[] = [];
  for (const { sym } of KR) {
    const c = hist.symbols[sym]?.candles ?? [];
    if (c.length < TRAIN_MIN + 50) continue;
    for (let t = 260; t < c.length - 1; t++) {
      const f = buildMultiFeatures(c, t, sox.get(prevDay(c[t].date)) ?? 0, kospi.get(c[t].date) ?? 0);
      if (!f) continue;
      const ret = (c[t + 1].close / c[t].close - 1) * 100;
      if (!isFinite(ret)) continue;
      rows.push({ date: c[t].date, x: KEYS.map((k) => f[k]), y: ret > 0 ? 1 : 0, ret });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  console.log("=== 상승 확률 모델 검증 ===");
  console.log(`전체 표본 ${rows.length.toLocaleString()}개 (국내 반도체 5종목, 다중 시간대 13개 특징)\n`);

  const evalStart = Math.max(TRAIN_MIN * 5, rows.length - EVAL_DAYS * 5);
  const evalRows = rows.slice(evalStart);
  const ys = evalRows.map((r) => r.y);
  const baseRate = rows.slice(0, evalStart).filter((r) => r.y === 1).length / evalStart;

  // ── 모델 1: 기저율 (항상 같은 확률) ──
  const pBase = evalRows.map(() => baseRate);

  // ── 모델 2: 로지스틱 (워크포워드, 250건마다 재적합) ──
  const pLogit: number[] = [];
  let w: number[] | null = null;
  for (let i = 0; i < evalRows.length; i++) {
    if (i % 250 === 0) {
      const tr = rows.slice(0, evalStart + i);
      w = fitLogistic(tr.map((r) => r.x), tr.map((r) => r.y));
    }
    pLogit.push(predictLogistic(w as number[], evalRows[i].x));
  }

  // ── 모델 3: 국면 조건부 기저율 (변동성 국면 × 낙폭 국면별 상승 비율) ──
  const bucketOf = (x: number[]) => {
    const vr = x[KEYS.indexOf("volRatio")];
    const dd = x[KEYS.indexOf("drawdown")];
    return `${vr > 0.3 ? "고변동" : vr < -0.2 ? "저변동" : "보통"}/${dd < -1.5 ? "붕괴" : dd < -0.5 ? "조정" : "고점권"}`;
  };
  const pRegime: number[] = [];
  for (let i = 0; i < evalRows.length; i++) {
    const tr = rows.slice(0, evalStart + i);
    const b = bucketOf(evalRows[i].x);
    const same = tr.filter((r) => bucketOf(r.x) === b);
    pRegime.push(same.length >= 50 ? same.filter((r) => r.y === 1).length / same.length : baseRate);
  }

  const models: [string, number[]][] = [
    ["기저율(정보 없음)", pBase],
    ["국면 조건부 기저율", pRegime],
    ["로지스틱(다중 시간대)", pLogit],
  ];

  console.log("모델".padEnd(24) + "Brier↓".padStart(9) + "AUC↑".padStart(8) + "적중률".padStart(9) + "기저율 대비");
  const results: Record<string, { brier: number; auc: number; acc: number }> = {};
  for (const [name, p] of models) {
    const b = brier(p, ys);
    const a = auc(p, ys);
    const acc = (p.filter((v, i) => (v >= 0.5 ? 1 : 0) === ys[i]).length / p.length) * 100;
    results[name] = { brier: b, auc: a, acc };
    const gain = ((brier(pBase, ys) - b) / brier(pBase, ys)) * 100;
    console.log(
      name.padEnd(24) + b.toFixed(4).padStart(9) + a.toFixed(3).padStart(8) + `${acc.toFixed(1)}%`.padStart(9) +
        `  ${gain >= 0 ? "+" : ""}${gain.toFixed(2)}% ${gain > 1 ? "✅ 개선" : gain > 0 ? "△ 미미" : "❌ 열위"}`,
    );
  }

  // ── 신뢰도(calibration): 확률 구간별로 실제 상승 비율이 맞는지 ──
  console.log("\n=== 신뢰도 점검: 로지스틱 모델 ===");
  console.log("예측 확률 구간".padEnd(16) + "표본".padStart(7) + "실제 상승률".padStart(12) + "  편차");
  const bins: [number, number][] = [[0, 0.45], [0.45, 0.5], [0.5, 0.55], [0.55, 0.6], [0.6, 1]];
  const calib: { lo: number; hi: number; n: number; predicted: number; actual: number }[] = [];
  for (const [lo, hi] of bins) {
    const idx = pLogit.map((p, i) => (p >= lo && p < hi ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 20) continue;
    const predicted = idx.reduce((a, i) => a + pLogit[i], 0) / idx.length;
    const actual = idx.filter((i) => ys[i] === 1).length / idx.length;
    calib.push({ lo, hi, n: idx.length, predicted, actual });
    const dev = (actual - predicted) * 100;
    console.log(
      `${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}%`.padEnd(16) + String(idx.length).padStart(7) +
        `${(actual * 100).toFixed(1)}%`.padStart(12) + `  ${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%p ${Math.abs(dev) <= 5 ? "✅" : "❌"}`,
    );
  }

  // ── 특징별 기여도 (마지막 적합의 계수) ──
  console.log("\n=== 어떤 시간대·요인이 방향과 관련 있나 (로지스틱 계수) ===");
  const coef = KEYS.map((k, j) => ({ k, v: (w as number[])[j] })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  for (const { k, v } of coef.slice(0, 8)) {
    console.log(`  ${k.padEnd(10)} ${v >= 0 ? "+" : ""}${v.toFixed(4)}  ${v > 0 ? "높을수록 상승" : "높을수록 하락"}`);
  }

  // ── 국면별 실측 상승률 (다중검정 보정) ──
  // 개별 날짜의 확률은 못 맞혀도, "이 국면에서 과거 상승 비율"은 말할 수 있을지 본다.
  // 국면을 21개로 쪼개 각각 검정하면 우연히 유의미해지는 것이 생기므로(21 × 5% ≈ 1개),
  // Bonferroni 보정(α = 0.05 / 국면수)을 적용해 진짜만 남긴다.
  const bucketFull = (x: number[]) => {
    const vr = x[KEYS.indexOf("volRatio")];
    const dd = x[KEYS.indexOf("drawdown")];
    const w1 = x[KEYS.indexOf("ret1w")];
    return `${vr > 0.3 ? "고변동" : vr < -0.2 ? "저변동" : "보통"}/${dd < -1.5 ? "붕괴" : dd < -0.5 ? "조정" : "고점권"}/${w1 > 0.5 ? "단기급등" : w1 < -0.5 ? "단기급락" : "횡보"}`;
  };
  const groups: Record<string, number[]> = {};
  for (const r of rows) (groups[bucketFull(r.x)] ??= []).push(r.y);
  const overall = rows.filter((r) => r.y === 1).length / rows.length;
  const eligible = Object.entries(groups).filter(([, v]) => v.length >= 80);
  const zCrit = 3.04; // Bonferroni 보정 후 임계값 (α=0.05/21 양측)
  console.log(`\n=== 국면별 실측 상승률 (전체 기저율 ${(overall * 100).toFixed(1)}%, 다중검정 보정) ===`);
  console.log("국면".padEnd(22) + "표본".padStart(7) + "상승률".padStart(9) + "z".padStart(7) + "  판정");
  const regimeRates = eligible
    .map(([k, v]) => {
      const p = v.filter((x) => x === 1).length / v.length;
      const se = Math.sqrt((p * (1 - p)) / v.length);
      const z = se > 0 ? (p - overall) / se : 0;
      return { regime: k, n: v.length, upRatePct: Number((p * 100).toFixed(1)), z: Number(z.toFixed(2)), significant: Math.abs(z) >= zCrit };
    })
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  for (const r of regimeRates.slice(0, 6)) {
    console.log(
      r.regime.padEnd(22) + String(r.n).padStart(7) + `${r.upRatePct}%`.padStart(9) + `${r.z}`.padStart(7) +
        `  ${r.significant ? "✅ 기저율과 다름" : "구분 안 됨"}`,
    );
  }
  const sigCount = regimeRates.filter((r) => r.significant).length;
  console.log(`보정 후 유의미한 국면: ${sigCount}/${regimeRates.length}개`);

  const best = Object.entries(results).sort((a, b) => a[1].brier - b[1].brier)[0];
  const gainPct = ((results["기저율(정보 없음)"].brier - best[1].brier) / results["기저율(정보 없음)"].brier) * 100;
  const usable = gainPct > 1 && best[0] !== "기저율(정보 없음)" && calib.every((c) => Math.abs(c.actual - c.predicted) <= 0.05);

  writeFileSync(
    join(process.cwd(), "data", "probability-stats.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        universe: "국내 반도체 5종목 (비반도체는 히스토리 축적 후 별도 검증 필요)",
        sample: evalRows.length,
        baseRatePct: Number((baseRate * 100).toFixed(1)),
        models: Object.fromEntries(
          Object.entries(results).map(([k, v]) => [k, { brier: Number(v.brier.toFixed(4)), auc: Number(v.auc.toFixed(3)), accuracyPct: Number(v.acc.toFixed(1)) }]),
        ),
        best: best[0],
        brierGainVsBasePct: Number(gainPct.toFixed(2)),
        calibration: calib.map((c) => ({ range: `${(c.lo * 100).toFixed(0)}~${(c.hi * 100).toFixed(0)}%`, n: c.n, predictedPct: Number((c.predicted * 100).toFixed(1)), actualPct: Number((c.actual * 100).toFixed(1)) })),
        topFactors: coef.slice(0, 8).map((c) => ({ feature: c.k, coef: Number(c.v.toFixed(4)) })),
        overallUpRatePct: Number((overall * 100).toFixed(1)),
        // 앱이 "오늘 오를 확률"로 제시할 수 있는 유일한 형태 — 국면별 과거 실측 비율.
        // significant=false면 "기저율과 구분되지 않는다"고 함께 표시해야 한다.
        regimeUpRates: regimeRates,
        significantRegimes: sigCount,
        usableForDisplay: usable,
        disclaimer:
          "워크포워드(미래정보 미사용) 실측입니다. usableForDisplay=false면 확률을 사용자에게 숫자로 제시해서는 안 됩니다.",
      },
      null,
      1,
    ),
  );

  console.log(`\n■ 판정`);
  console.log(`  최우수 모델: ${best[0]} (Brier ${best[1].brier.toFixed(4)}, 기저율 대비 ${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(2)}%)`);
  if (usable) {
    console.log(`  ✅ 확률을 숫자로 제시할 근거가 있다. 단 개선폭이 작으므로 "확률"로만 말하고 단정은 금지.`);
  } else if (gainPct > 1) {
    console.log(`  ⚠️ Brier는 개선됐지만 신뢰도(구간별 실제 상승률) 편차가 5%p를 넘는다 — 확률 숫자를 그대로 보여주면 안 된다.`);
  } else {
    console.log(`  ❌ 기저율을 의미 있게 넘지 못했다. "오늘 오를 확률 N%"를 표시하면 안 된다.`);
  }
  console.log(`\ndata/probability-stats.json 저장 완료`);
}

main();
