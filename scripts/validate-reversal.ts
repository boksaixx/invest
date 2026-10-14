// 엔진 점수의 "방향 정확도"를 5개년 일봉으로 재현 검증한다 — 2026-10 정확도 하락 진단에서 만든 하니스.
//
// 실행: npx tsx scripts/validate-reversal.ts            (결과 요약 출력)
//       SAVE=1 npx tsx scripts/validate-reversal.ts     (data/reversal-stats.json 저장)
//
// 왜 있나: 실전 로그(validate-live-signals.ts)는 수십 거래일뿐이라 기간마다 결론이 뒤집힌다.
// 엔진이 실제로 쓰는 점수 함수(technicalScore·macroScore·intradayScore)를 그대로 불러,
// 5개년 일봉에서 두 시점의 판단을 재현하고 그 뒤 실제 등락과 비교한다.
//
//   ① 개장 직후(장중):  현재가 = 당일 시가, 일봉은 전일까지, 장중 정보는 갭만 안다.
//                        정답 = 시가 → 당일 종가 (단타)
//   ② 마감 직전:        현재가 = 당일 종가, 장중 정보는 시가·고가·저가·갭·당일 레인지 위치.
//                        정답 = 종가 → 익일 종가 (오버나이트)
//
// 한계: 분봉 이력이 없어 VWAP·오프닝레인지·30분 모멘텀은 재현하지 못한다(중립으로 둔다).
//       미국 지수 선물·뉴스·공시·수급도 과거 시점 값이 없어 뺐다. 즉 이 하니스는 "일봉 기술점수 +
//       오버나이트 매크로 + 갭·레인지 위치"가 방향을 맞히는지만 잰다.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { intradayScore, macroScore, technicalScore } from "../lib/engine";
import { computeIndicators } from "../lib/indicators";
import type { Candle, IntradayInsight, MacroSnapshot, Quote } from "../lib/types";
import { STOCKS } from "../lib/types";

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };
const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;
const KR = (Object.keys(STOCKS) as (keyof typeof STOCKS)[]).filter((t) => STOCKS[t].market === "KR");

const series = (sym: string) => {
  const c = hist.symbols[sym]?.candles ?? [];
  const m = new Map<string, { close: number; chg: number }>();
  for (let i = 1; i < c.length; i++) m.set(c[i].date, { close: c[i].close, chg: (c[i].close / c[i - 1].close - 1) * 100 });
  return { list: c, m };
};
const sox = series("^SOX");
const ndx = series("^IXIC");
const vix = series("^VIX");
const oil = series("CL=F");
const krw = series("KRW=X");
const kospi = series("^KS11");
const kospiCandles = new Map(kospi.list.map((c, i) => [c.date, { c, prev: kospi.list[i - 1] }]));

/** 국내 D일 아침에 알 수 있는 "가장 최근 미국 거래일" 값 (D-1 이하 중 가장 최근) */
function usBefore(s: ReturnType<typeof series>, d: string) {
  let best: { close: number; chg: number } | null = null;
  for (const c of s.list) {
    if (c.date >= d) break;
    best = s.m.get(c.date) ?? best;
  }
  return best;
}
const q = (name: string, v: { close: number; chg: number } | null): Quote | null =>
  v ? { symbol: name, name, price: v.close, prevClose: v.close / (1 + v.chg / 100), change: 0, changePct: v.chg, currency: "", time: "" } : null;

function macroAt(d: string, kospiChgPct: number | null): MacroSnapshot {
  return {
    usdkrw: q("KRW=X", usBefore(krw, d)),
    kospi: kospiChgPct == null ? null : q("^KS11", { close: 0, chg: kospiChgPct }),
    nasdaq: q("^IXIC", usBefore(ndx, d)),
    sox: q("^SOX", usBefore(sox, d)),
    nikkei: null, shanghai: null,
    vix: q("^VIX", usBefore(vix, d)),
    spFutures: null, nasdaqFutures: null, fearGreed: null,
    oil: q("CL=F", usBefore(oil, d)),
    us10y: null,
  };
}
function intradayAt(open: number, high: number, low: number, cur: number, prevClose: number): IntradayInsight {
  const gapPct = (open / prevClose - 1) * 100;
  const range = high - low;
  const typical = (high + low + cur) / 3;
  return {
    available: true, sessionDate: "", isToday: true,
    todayOpen: open, todayHigh: high, todayLow: low, current: cur,
    vwap: typical, distanceFromVwapPct: 0, // 분봉이 없어 VWAP 이격은 재현하지 않는다(중립)
    gapPct, gapType: gapPct > 0.3 ? "갭상승" : gapPct < -0.3 ? "갭하락" : "보합",
    rangePositionPct: range > 0 ? ((cur - low) / range) * 100 : 50,
    openingRangeHigh: null, openingRangeLow: null, orbStatus: "판단불가", momentum: "중립",
  };
}
const phase = (p: string) => ({ phase: p, kstTime: "", note: "" });

type Ev = { d: string; t: string; score: number; tech: number; mac: number; intra: number; fwd: number; parts?: Record<string, number> };
const openEv: Ev[] = [];
const closeEv: Ev[] = [];
for (const t of KR) {
  const c = hist.symbols[STOCKS[t].yahoo]?.candles ?? [];
  for (let i = 261; i < c.length - 1; i++) {
    const today = c[i];
    const prev = c[i - 1];
    if (!(today.open > 0 && prev.close > 0)) continue;
    const ind = computeIndicators(c.slice(i - 260, i)); // 전일까지 완성봉
    const kc = kospiCandles.get(today.date);
    // 엔진(runEngine)과 같은 방식: 갭 되돌림의 σ는 ATR/1.2로 근사
    const sigOf = (p: number) => (!isNaN(ind.atr14) && p > 0 ? ((ind.atr14 / p) * 100) / 1.2 : null);
    // ① 개장 직후
    {
      const price = today.open;
      const ts = technicalScore(ind, price);
      const tech = ts.score - 50;
      const kChg = kc?.prev ? (kc.c.open / kc.prev.close - 1) * 100 : null;
      const mac = macroScore(macroAt(today.date, kChg), phase("장중"), "KR").score;
      const intra = intradayScore(intradayAt(today.open, today.open, today.open, price, prev.close), phase("장중"), sigOf(price)).score;
      openEv.push({ d: today.date, t, tech, mac, intra, score: Math.max(0, Math.min(100, 50 + tech + mac + intra)), fwd: (today.close / price - 1) * 100, parts: ts.parts });
    }
    // ② 마감 직전 (현재가 = 종가)
    {
      const price = today.close;
      const ts = technicalScore(ind, price);
      const tech = ts.score - 50;
      const kChg = kc?.prev ? (kc.c.close / kc.prev.close - 1) * 100 : null;
      const mac = macroScore(macroAt(today.date, kChg), phase("마감임박"), "KR").score;
      const intra = intradayScore(intradayAt(today.open, today.high, today.low, price, prev.close), phase("마감임박"), sigOf(price)).score;
      closeEv.push({ d: today.date, t, tech, mac, intra, score: Math.max(0, Math.min(100, 50 + tech + mac + intra)), fwd: (c[i + 1].close / price - 1) * 100, parts: ts.parts });
    }
  }
}

function rank(v: number[]) {
  const idx = v.map((x, i) => [x, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function ic(a: number[], b: number[]) {
  if (a.length < 30) return NaN;
  const ra = rank(a), rb = rank(b);
  const m = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = m(ra), mb = m(rb);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
}
const years = [...new Set(openEv.map((e) => e.d.slice(0, 4)))].sort();
function report(label: string, E: Ev[]) {
  const rows: Record<string, unknown>[] = [];
  console.log(`\n=== ${label} ===`);
  console.log("연도   표본   IC(점수)  IC(기술) IC(매크로) IC(장중) | 점수68+ 건수  승률   평균    | 점수≤32 건수  승률   평균");
  for (const y of [...years, "전체"]) {
    const Y = y === "전체" ? E : E.filter((e) => e.d.startsWith(y));
    if (Y.length < 50) continue;
    const f = (k: keyof Ev) => ic(Y.map((e) => e[k] as number), Y.map((e) => e.fwd));
    const hi = Y.filter((e) => e.score >= 68);
    const lo = Y.filter((e) => e.score <= 32);
    const st = (a: Ev[]) => ({ n: a.length, win: a.length ? (a.filter((e) => e.fwd > 0).length / a.length) * 100 : NaN, avg: a.length ? a.reduce((s, e) => s + e.fwd, 0) / a.length : NaN });
    const H = st(hi), L = st(lo);
    const row = { year: y, n: Y.length, icScore: f("score"), icTech: f("tech"), icMacro: f("mac"), icIntra: f("intra"), hi: H, lo: L };
    const r3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
    const rs = (o: { n: number; win: number; avg: number }) => ({ n: o.n, win: r3(o.win), avg: r3(o.avg) });
    rows.push({ ...row, icScore: r3(row.icScore), icTech: r3(row.icTech), icMacro: r3(row.icMacro), icIntra: r3(row.icIntra), hi: rs(H), lo: rs(L) });
    console.log(
      `${y.padEnd(5)} ${String(Y.length).padStart(5)}  ${row.icScore.toFixed(3).padStart(7)}  ${row.icTech.toFixed(3).padStart(7)}  ${row.icMacro.toFixed(3).padStart(7)}  ${row.icIntra.toFixed(3).padStart(7)} | ` +
        `${String(H.n).padStart(9)} ${H.win.toFixed(1).padStart(5)}% ${H.avg >= 0 ? "+" : ""}${H.avg.toFixed(2)}% | ${String(L.n).padStart(9)} ${L.win.toFixed(1).padStart(5)}% ${L.avg >= 0 ? "+" : ""}${L.avg.toFixed(2)}%`,
    );
  }
  return rows;
}
const current = {
  open: report("① 개장 직후 판단 → 당일 종가", openEv),
  close: report("② 마감 직전 판단 → 익일 종가", closeEv),
};
if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify({ openEv, closeEv }));
if (process.env.SAVE === "1") {
  // "before"는 2026-10 개정 전 엔진으로 한 번 잰 기록이다 — 다시 재지 않고 보존한다(비교 기준).
  const path = join(process.cwd(), "data", "reversal-stats.json");
  let before: unknown = null;
  try {
    before = JSON.parse(readFileSync(path, "utf8")).before ?? null;
  } catch {
    before = null;
  }
  const out = {
    generatedAt: new Date().toISOString(),
    note: "엔진 점수 함수를 5개년 일봉에 그대로 적용한 방향 정확도 재현(분봉·선물·뉴스 제외). IC>0이면 점수가 높을수록 실제로 더 올랐다는 뜻.",
    after: current,
    before,
  };
  writeFileSync(path, JSON.stringify(out, null, 1));
  console.log(`\n저장: ${path}`);
}

// ── 회귀 방지: 점수가 다시 거꾸로 가면 실패로 끝낸다 ──
{
  const total = (rows: Record<string, unknown>[]) => rows.find((r) => r.year === "전체") as { icScore: number | null } | undefined;
  const o = total(current.open)?.icScore ?? NaN;
  const c = total(current.close)?.icScore ?? NaN;
  const yearsNeg = [...current.open, ...current.close].filter((r) => r.year !== "전체" && ((r as { icScore: number | null }).icScore ?? 0) < -0.02);
  console.log(`\n회귀 검사: 전체 IC 개장 직후 ${o} / 마감 직전 ${c}, -0.02 미만인 연도 ${yearsNeg.length}개`);
  if (!(o > 0) || !(c > 0) || yearsNeg.length > 0) {
    console.error("❌ 엔진 점수의 방향 정확도가 기준 아래로 떨어졌습니다 — 가중치 변경을 다시 검토하세요");
    process.exitCode = 1;
  } else {
    console.log("✅ 통과 — 두 시점 모두 점수가 높을수록 실제로 더 올랐고, 크게 거꾸로 간 해가 없습니다");
  }
}
