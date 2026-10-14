// 삼성전자·SK하이닉스 예측 모델 학습 + 워크포워드 검증 → data/model.json
//
// 실행: npx tsx scripts/train-model.ts      (먼저 npx tsx scripts/backfill-deep.ts)
//
// 원칙
//  · 특징은 lib/predict.ts 의 함수로 계산한다 — 실시간 앱과 학습이 같은 정의를 쓴다.
//  · 검증은 워크포워드: 그 해(또는 분기) 이전 데이터로만 학습해 그 기간에 적용한 성적만 기록한다.
//    화면의 "과거 비슷한 상황 N번 중 M번"은 이 검증 성적에서 나온다(학습 데이터로 잰 숫자가 아니다).
//  · 모델은 일부러 단순하다(특징 6~7개 로지스틱). 2종목·10년이면 복잡한 모델은 과거만 외운다.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../lib/types";
import {
  aucOf, calibrate, CHECKPOINTS, dailySigmaPct, fitLogit, HOUR_FEATURES, intradayFeatures, OPEN_FEATURES, priorFeatures, spearman,
  SWING_FEATURES, type Checkpoint, type Features, type LogitModel, type ModelEval, type RegimeEval, type TwoStockModel,
} from "../lib/predict";
import { regimeKeys } from "../lib/regime";
import type { DeepHistory } from "./backfill-deep";

const C_REG = 0.1;
const SWING_DAYS = Number(process.env.SWING_DAYS ?? 3);
const SWING_FEATS: readonly string[] = process.env.SWING_FEATS ? process.env.SWING_FEATS.split(",") : SWING_FEATURES;
const deep = JSON.parse(readFileSync(join(process.cwd(), "data", "deep-history.json"), "utf8")) as DeepHistory;
const CODES = ["005930", "000660"] as const;
const PAIR: Record<string, string> = { "005930": "000660", "000660": "005930" };

const toCandles = (bars: { d: string; o: number; h: number; l: number; c: number; v: number }[]): Candle[] =>
  bars.map((b) => ({ date: b.d, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));

/** 미국 지수: 날짜 D(국내) 아침에 알 수 있는 직전 정규장 등락률과 60일 σ */
function usSeries(key: "nvda" | "sox" | "mu") {
  const bars = deep.daily[key] ?? [];
  const pts: { d: string; pct: number; sigma: number }[] = [];
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const r = (bars[i].c / bars[i - 1].c - 1) * 100;
    rets.push(r);
    const w = rets.slice(-60);
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, w.length - 1));
    pts.push({ d: bars[i].d, pct: r, sigma: sd });
  }
  return (krDate: string) => {
    // krDate 보다 이른 마지막 미국 거래일
    let lo = 0, hi = pts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].d < krDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 && w60ok(ans) ? pts[ans] : null;
  };
  function w60ok(i: number) { return i >= 59; }
}
const nvdaAt = usSeries("nvda");
const soxAt = usSeries("sox");
const muAt = usSeries("mu");

type Sample = { code: string; d: string; f: Features; ret: number };
const openS: Sample[] = [];
const swingS: Sample[] = [];
const hourS: Record<string, Sample[]> = Object.fromEntries(CHECKPOINTS.filter((c) => c !== "open").map((c) => [c, []]));
const preGapRows: { nvdaZ: number; soxZ: number; muZ: number; gapZ: number }[] = [];

for (const code of CODES) {
  const daily = toCandles(deep.daily[code]);
  const pairAll = toCandles(deep.daily[PAIR[code]]);
  const flows = (deep.flows[code] ?? []).map((x) => ({ d: x.d, foreign: x.foreign, inst: x.inst }));
  const hourly = deep.hourly[code] ?? [];
  const hourByDay = new Map<string, typeof hourly>();
  for (const b of hourly) {
    const d = b.t.slice(0, 10);
    if (!hourByDay.has(d)) hourByDay.set(d, []);
    hourByDay.get(d)!.push(b);
  }
  let pi = 0, fi = 0;
  for (let i = 30; i < daily.length; i++) {
    const today = daily[i];
    // 야후 일봉의 잘못된 날(거래량이 20일 중앙값의 20% 미만, 고저 역전)은 건너뛴다
    const vwin = daily.slice(i - 20, i).map((x) => x.volume).sort((a, b) => a - b);
    const vmed = vwin[Math.floor(vwin.length / 2)];
    if (!(today.volume >= 0.2 * vmed) || !(today.high >= today.low) || !(today.open > 0)) continue;
    while (pi < pairAll.length && pairAll[pi].date < today.date) pi++;
    while (fi < flows.length && flows[fi].d < today.date) fi++;
    const prior = daily.slice(Math.max(0, i - 260), i);
    const nv = nvdaAt(today.date);
    const sx = soxAt(today.date);
    const mu = muAt(today.date);
    const pf = priorFeatures(
      { candles: prior, pairCandles: pairAll.slice(Math.max(0, pi - 30), pi), flows: flows.slice(Math.max(0, fi - 10), fi) },
      {
        nvdaPct: nv?.pct ?? null, soxPct: sx?.pct ?? null, muPct: mu?.pct ?? null,
        nvdaSigma: nv?.sigma ?? null, soxSigma: sx?.sigma ?? null, muSigma: mu?.sigma ?? null,
      },
    );
    if (!pf) continue;
    // 수급 데이터가 없는 기간(2019 이전)은 수급 특징을 비워 둔다 → 스윙 표본에서 빠진다
    if (fi < 5) { delete pf.f.frgn5; delete pf.f.inst5; }
    const closes = prior.map((x) => x.close);

    // ① 개장(시가 매수 → 당일 종가)
    const atOpen = intradayFeatures(pf.f, pf.sigma, pf.prevClose, closes, { open: today.open, high: today.open, low: today.open, price: today.open });
    openS.push({ code, d: today.date, f: atOpen, ret: (today.close / today.open - 1) * 100 });
    if (atOpen.nvdaZ != null && atOpen.soxZ != null && atOpen.muZ != null && atOpen.gapZ != null) {
      preGapRows.push({ nvdaZ: atOpen.nvdaZ, soxZ: atOpen.soxZ, muZ: atOpen.muZ, gapZ: atOpen.gapZ });
    }

    // ② 종가 판단(종가 매수 → 3거래일 뒤 종가)
    if (i + SWING_DAYS < daily.length) {
      const atClose = intradayFeatures(pf.f, pf.sigma, pf.prevClose, closes, { open: today.open, high: today.high, low: today.low, price: today.close });
      swingS.push({ code, d: today.date, f: atClose, ret: (daily[i + SWING_DAYS].close / today.close - 1) * 100 });
    }

    // ③ 장중 시점(10~15시): 1시간봉으로 "그 시각 가격·그때까지 고저"를 재현 → 당일 종가까지
    const hb = hourByDay.get(today.date);
    if (hb && hb.length >= 6 && hb[0].t.endsWith("09:00")) {
      let hi = today.open, lo = today.open;
      for (const b of hb) {
        hi = Math.max(hi, b.h);
        lo = Math.min(lo, b.l);
        const hh = Number(b.t.slice(11, 13)) + 1; // 이 봉의 종가 = 다음 정각 가격
        if (hh < 10 || hh > 15) continue;
        const f = intradayFeatures(pf.f, pf.sigma, pf.prevClose, closes, { open: today.open, high: hi, low: lo, price: b.c });
        hourS[`h${hh}`].push({ code, d: today.date, f, ret: (today.close / b.c - 1) * 100 });
      }
    }
  }
}

const clip = (v: number) => Math.max(-3, Math.min(3, v));
function complete(s: Sample, feats: readonly string[]) {
  return feats.every((k) => Number.isFinite(s.f[k as keyof Features] as number));
}
function fit(samples: Sample[], feats: readonly string[]): LogitModel {
  const X = samples.map((s) => feats.map((k) => s.f[k as keyof Features] as number));
  const y = samples.map((s) => (s.ret > 0 ? 1 : 0));
  const { coef, intercept } = fitLogit(X, y, C_REG);
  return { features: [...feats], coef: coef.map((v) => Math.round(v * 10000) / 10000), intercept: Math.round(intercept * 10000) / 10000 };
}
function prob(m: LogitModel, s: Sample) {
  let z = m.intercept;
  m.features.forEach((k, i) => (z += m.coef[i] * Math.max(-3, Math.min(3, s.f[k as keyof Features] as number))));
  return 1 / (1 + Math.exp(-z));
}

/** 워크포워드: 경계(boundaries)마다 그 이전 데이터로 학습 → 다음 경계까지 적용 */
function walkForward(
  all: Sample[], feats: readonly string[], boundaries: string[],
  /** 검증 표본의 특징을 실전처럼 바꿔 넣는 함수 (예: 장전에는 시가를 모르니 갭을 추정값으로) — 학습 표본으로만 만든다 */
  testTransform?: (train: Sample[]) => (s: Sample) => Sample,
): { model: LogitModel; eval: ModelEval } {
  const S = all.filter((s) => complete(s, feats)).sort((a, b) => a.d.localeCompare(b.d));
  const oos: { s: Sample; p: number }[] = [];
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b];
    const end = boundaries[b + 1] ?? "9999";
    const tr = S.filter((s) => s.d < start);
    const te = S.filter((s) => s.d >= start && s.d < end);
    if (tr.length < 200 || te.length === 0) continue;
    const m = fit(tr, feats);
    const tf = testTransform ? testTransform(tr) : (x: Sample) => x;
    for (const s of te) oos.push({ s, p: prob(m, tf(s)) });
  }
  const p = oos.map((o) => o.p);
  const ret = oos.map((o) => o.s.ret);
  const y: number[] = ret.map((r) => (r > 0 ? 1 : 0));
  const years = [...new Set(oos.map((o) => o.s.d.slice(0, 4)))].sort();
  // 국면별 성적 — 같은 워크포워드 예측을 국면으로 나눠서 잰다 (국면은 모델 입력이 아니다)
  const byRegime: Record<string, RegimeEval> = {};
  const groups = new Map<string, { p: number; ret: number }[]>();
  for (const o of oos) for (const k of regimeKeys(o.s.f)) {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push({ p: o.p, ret: o.s.ret });
  }
  for (const [k, g] of groups) {
    const yy = g.map((x) => (x.ret > 0 ? 1 : 0));
    byRegime[k] = {
      n: g.length,
      auc: Math.round(aucOf(g.map((x) => x.p), yy) * 1000) / 1000,
      baseUpPct: Math.round((yy.reduce((a: number, b) => a + b, 0) / Math.max(1, yy.length)) * 1000) / 10,
      calib: calibrate(g.map((x) => x.p), g.map((x) => x.ret)),
    };
  }
  const ev: ModelEval = {
    n: oos.length,
    auc: Math.round(aucOf(p, y) * 1000) / 1000,
    ic: Math.round(spearman(p, ret) * 1000) / 1000,
    baseUpPct: Math.round((y.reduce((a, b) => a + b, 0) / Math.max(1, y.length)) * 1000) / 10,
    period: oos.length ? `${oos[0].s.d} ~ ${oos[oos.length - 1].s.d}` : "-",
    calib: calibrate(p, ret),
    byYear: years.map((yr) => {
      const sel = oos.filter((o) => o.s.d.startsWith(yr));
      return { year: yr, n: sel.length, auc: Math.round(aucOf(sel.map((o) => o.p), sel.map((o) => (o.s.ret > 0 ? 1 : 0))) * 1000) / 1000 };
    }),
    byRegime,
  };
  return { model: fit(S, feats), eval: ev };
}

const yearStarts = ["2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026"].map((y) => `${y}-01-01`);
const quarterStarts: string[] = [];
for (let y = 2024; y <= 2027; y++) for (const m of ["01", "04", "07", "10"]) quarterStarts.push(`${y}-${m}-01`);
const hourBounds = quarterStarts.filter((q) => q >= "2024-07-01");

const day = {} as TwoStockModel["day"];
const o = walkForward(openS, OPEN_FEATURES, yearStarts);
day.open = { ...o.model, eval: o.eval };
// 장전(8시 반~9시) 판단 검증: 시가를 모르니 갭을 "학습 기간으로 만든 갭 추정식"으로 바꿔 넣고 같은 개장 모델을 적용
const preEval = walkForward(openS, OPEN_FEATURES, yearStarts, (tr) => {
  const g = ols(tr.filter((s) => s.f.nvdaZ != null && s.f.soxZ != null && s.f.muZ != null && s.f.gapZ != null)
    .map((s) => ({ nvdaZ: s.f.nvdaZ!, soxZ: s.f.soxZ!, muZ: s.f.muZ!, gapZ: s.f.gapZ! })));
  return (s) => ({ ...s, f: { ...s.f, gapZ: g.nvda * clip(s.f.nvdaZ!) + g.sox * clip(s.f.soxZ!) + g.mu * clip(s.f.muZ!) + g.c } });
}).eval;
for (const cp of CHECKPOINTS.filter((c) => c !== "open") as Checkpoint[]) {
  const r = walkForward(hourS[cp], HOUR_FEATURES, hourBounds);
  day[cp] = { ...r.model, eval: r.eval };
}
const sw = walkForward(swingS, SWING_FEATS, yearStarts);

// 장전 갭 추정식 (최소제곱): gapZ ≈ a·nvdaZ + b·soxZ + m·muZ + c
function ols(rows: { nvdaZ: number; soxZ: number; muZ: number; gapZ: number }[]) {
  const X = rows.map((r) => [r.nvdaZ, r.soxZ, r.muZ, 1].map((v, i) => (i < 3 ? Math.max(-3, Math.min(3, v)) : v)));
  const y = rows.map((r) => r.gapZ);
  const d = 4;
  const M = Array.from({ length: d }, (_, i) => [
    ...Array.from({ length: d }, (_, j) => X.reduce((a, x) => a + x[i] * x[j], 0)),
    X.reduce((a, x, k) => a + x[i] * y[k], 0),
  ]);
  for (let c = 0; c < d; c++) {
    let p = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < d; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= d; k++) M[r][k] -= f * M[c][k]; }
  }
  const b = M.map((r, i) => r[d] / r[i]);
  return { nvda: b[0], sox: b[1], mu: b[2], c: b[3] };
}
const g = ols(preGapRows);
const lastNv = nvdaAt("9999-12-31");
const lastSx = soxAt("9999-12-31");
const lastMu = muAt("9999-12-31");

const out: TwoStockModel = {
  generatedAt: new Date().toISOString(),
  dataRange: {
    daily: `${deep.daily["005930"]?.[0]?.d} ~ ${deep.daily["005930"]?.at(-1)?.d}`,
    hourly: `${deep.hourly["005930"]?.[0]?.t?.slice(0, 10)} ~ ${deep.hourly["005930"]?.at(-1)?.t?.slice(0, 10)}`,
    flows: `${deep.flows["005930"]?.[0]?.d} ~ ${deep.flows["005930"]?.at(-1)?.d}`,
  },
  day,
  swing: { ...sw.model, eval: sw.eval, horizonDays: SWING_DAYS },
  preEval,
  preGap: { nvda: Math.round(g.nvda * 1000) / 1000, sox: Math.round(g.sox * 1000) / 1000, mu: Math.round(g.mu * 1000) / 1000, c: Math.round(g.c * 1000) / 1000 },
  usSigmaFallback: {
    nvda: Math.round((lastNv?.sigma ?? 2.5) * 100) / 100,
    sox: Math.round((lastSx?.sigma ?? 2) * 100) / 100,
    mu: Math.round((lastMu?.sigma ?? 3) * 100) / 100,
  },
};
writeFileSync(join(process.cwd(), "data", "model.json"), JSON.stringify(out, null, 1));

const line = (name: string, ev: ModelEval) => {
  const top = ev.calib.filter((c) => c.lo >= 0.55 && c.n > 0);
  const bot = ev.calib.filter((c) => c.hi <= 0.45 && c.n > 0);
  const agg = (rows: typeof ev.calib) => {
    const n = rows.reduce((a, r) => a + r.n, 0);
    return n ? `${n}회 상승 ${(rows.reduce((a, r) => a + r.upPct * r.n, 0) / n).toFixed(1)}% 평균 ${(rows.reduce((a, r) => a + r.avgPct * r.n, 0) / n).toFixed(2)}%` : "0회";
  };
  console.log(`${name.padEnd(14)} 검증 ${String(ev.n).padStart(5)}건 AUC ${ev.auc.toFixed(3)} IC ${ev.ic.toFixed(3)} 기저 ${ev.baseUpPct}% | 확률≥55%: ${agg(top)} | ≤45%: ${agg(bot)}`);
};
console.log(`데이터: 일봉 ${out.dataRange.daily} · 1시간봉 ${out.dataRange.hourly} · 수급 ${out.dataRange.flows}`);
line("개장→종가", day.open.eval);
line("장전(갭추정)", preEval);
for (const cp of CHECKPOINTS.filter((c) => c !== "open")) line(`${cp.slice(1)}시→종가`, day[cp].eval);
line(`종가→${SWING_DAYS}일 뒤`, sw.eval);
console.log("개장 모델 연도별 AUC:", day.open.eval.byYear?.map((y) => `${y.year} ${y.auc}`).join(" · "));
console.log("스윙 모델 연도별 AUC:", sw.eval.byYear?.map((y) => `${y.year} ${y.auc}`).join(" · "));
const rg = (name: string, ev: ModelEval) =>
  console.log(`${name} 국면별 AUC:`, Object.entries(ev.byRegime ?? {}).sort().map(([k, r]) => `${k} ${r.auc}(${r.n})`).join(" · "));
rg("개장", day.open.eval);
rg("10시", day.h10.eval);
rg("11시", day.h11.eval);
console.log("장전 갭 추정:", out.preGap, "미국 σ:", out.usSigmaFallback);
console.log("저장: data/model.json");
void dailySigmaPct;
