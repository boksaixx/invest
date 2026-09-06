// "추격 매수" 판정 규칙 검증 — 당일 고가권(레인지 95%+) 차단을 VWAP 이격 기준으로 바꾼 근거.
//
// 실행: npx tsx scripts/validate-chase-rule.ts
//
// 왜 있나: 2026-09 시점 42일 자동수집 로그에서 신규 진입이 막힌 129건 중 126건이
// "당일 고가권" 규칙 때문이었다. 점수 90점대 종목이 "절대 금지"로 막히는 일이 매일 반복됐고,
// 사용자는 "사라는 신호를 준 적이 없다"고 느꼈다. 규칙을 바꾸기 전에 두 가지를 잰다.
//
//  A. 5년 일봉: "고가권 마감(레인지 상위 95%+)"이 다음날 실제로 불리했는가?
//  B. 42일 실측 로그: 차단된 신호와 허용된 신호의 사후 수익, 그리고 VWAP 이격별 성과.
//     → 새 규칙(RSI 72+ 또는 VWAP +2% 이상)으로 바꾸면 차단/허용이 어떻게 달라지는가.
//
// 결론(2026-09-06 실행 기준)은 lib/engine.ts 상단 CHASE_VWAP_PCT 주석에 옮겨 적었다.
// 데이터가 더 쌓이면 다시 돌려 그 주석을 갱신할 것.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Candle, CollectedSnapshot } from "../lib/types";
import { CHASE_VWAP_PCT } from "../lib/engine";

const DATA = join(process.cwd(), "data");

// ───────────────────────── A. 5년 일봉 ─────────────────────────
console.log("=== A. 5년 일봉 — 고가권 마감(레인지 95%+) 다음날 ===");
const hist = JSON.parse(readFileSync(join(DATA, "market-history.json"), "utf8")) as {
  symbols: Record<string, { name: string; candles: Candle[] }>;
};
const KR = Object.keys(hist.symbols).filter((s) => s.endsWith(".KS"));
type Rec = { r1: number; gap: number; up: boolean };
const bucket: Record<"고가권" | "중간" | "저가권", Rec[]> = { 고가권: [], 중간: [], 저가권: [] };
for (const s of KR) {
  const c = hist.symbols[s].candles;
  for (let i = 1; i < c.length - 1; i++) {
    const x = c[i];
    const range = x.high - x.low;
    if (range <= 0) continue;
    const rp = ((x.close - x.low) / range) * 100;
    const nxt = c[i + 1];
    const rec: Rec = { r1: (nxt.close / x.close - 1) * 100, gap: (nxt.open / x.close - 1) * 100, up: x.close > c[i - 1].close };
    if (rp >= 95) bucket.고가권.push(rec);
    else if (rp <= 5) bucket.저가권.push(rec);
    else bucket.중간.push(rec);
  }
}
const st = (a: Rec[], k: keyof Rec) => {
  const v = a.map((x) => Number(x[k]));
  const avg = v.reduce((p, q) => p + q, 0) / Math.max(1, v.length);
  const win = (v.filter((x) => x > 0).length / Math.max(1, v.length)) * 100;
  return `평균 ${avg >= 0 ? "+" : ""}${avg.toFixed(3)}% 승률 ${win.toFixed(1)}%`;
};
for (const k of ["고가권", "중간", "저가권"] as const) {
  console.log(`  ${k.padEnd(4)} n=${String(bucket[k].length).padStart(5)} | 익일 종가 ${st(bucket[k], "r1")} | 익일 시가 갭 ${st(bucket[k], "gap")}`);
}
const hiUp = bucket.고가권.filter((x) => x.up);
console.log(`  고가권 중 상승일 마감 n=${hiUp.length} | 익일 종가 ${st(hiUp, "r1")}  ← 강한 종목이 고가권에서 마감한 경우`);
console.log("  해석: 고가권 마감이 다음날 뚜렷이 불리하지 않다(상승일에 한정하면 ≈0). 차단 근거로 부족.");

// ───────────────────────── B. 42일 실측 로그 ─────────────────────────
console.log("\n=== B. 자동수집 로그 — 허용된 신규매수 vs 차단된 신호 (장중 첫 발생 기준) ===");
const files = readdirSync(join(DATA, "log")).filter((f) => f.endsWith(".json")).sort();
type Snap = { t: string; sig: Record<string, { a: string; sc: number; b: boolean; p: number; rp: number; rsi: number; vd: number | null; ph: string; name: string }> };
const days: { date: string; snaps: Snap[] }[] = [];
for (const f of files) {
  let arr: CollectedSnapshot[];
  try {
    arr = JSON.parse(readFileSync(join(DATA, "log", f), "utf8"));
  } catch {
    continue;
  }
  const snaps: Snap[] = arr
    .filter((s) => s.signals)
    .map((s) => ({
      t: s.collectedAt,
      sig: Object.fromEntries(
        s.signals!.map((x) => [
          x.ticker,
          {
            a: x.action,
            sc: x.score,
            b: x.entryBlocked,
            p: x.price,
            rp: x.intraday?.rangePositionPct ?? 50,
            rsi: x.indicators?.rsi14 ?? NaN,
            vd: x.intraday?.available ? x.intraday.distanceFromVwapPct : null,
            ph: x.marketPhase?.phase ?? "?",
            name: x.name,
          },
        ]),
      ),
    }));
  days.push({ date: f.slice(0, 10), snaps });
}
const closeOf = (d: { snaps: Snap[] }, t: string) => {
  const last = [...d.snaps].reverse().find((s) => s.sig[t] && ["장마감", "동시호가", "마감임박"].includes(s.sig[t].ph));
  return last ? last.sig[t].p : null;
};
type Ev = { cat: "허용" | "차단"; vd: number | null; rsi: number; rp: number; r0: number; r1: number | null; newRule: "허용" | "추격대기" };
const events: Ev[] = [];
for (let i = 0; i < days.length; i++) {
  const d = days[i];
  const next = days[i + 1];
  const seen = new Set<string>();
  for (const s of d.snaps) {
    for (const [t, x] of Object.entries(s.sig)) {
      if (!["장중", "장초반", "점심시간대"].includes(x.ph) || seen.has(t)) continue;
      let cat: Ev["cat"] | null = null;
      if (x.a === "신규매수") cat = "허용";
      else if (x.b && x.sc >= 68) cat = "차단";
      if (!cat) continue;
      seen.add(t);
      const c0 = closeOf(d, t);
      const c1 = next ? closeOf(next, t) : null;
      if (c0 == null) continue;
      const newRule: Ev["newRule"] = x.rsi > 72 || (x.vd != null && x.vd > CHASE_VWAP_PCT) ? "추격대기" : "허용";
      events.push({ cat, vd: x.vd, rsi: x.rsi, rp: x.rp, r0: (c0 / x.p - 1) * 100, r1: c1 ? (c1 / x.p - 1) * 100 : null, newRule });
    }
  }
}
const stats = (arr: Ev[], k: "r0" | "r1") => {
  const v = arr.map((a) => a[k]).filter((x): x is number => x != null);
  if (!v.length) return "n=0";
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const win = (v.filter((x) => x > 0).length / v.length) * 100;
  return `n=${String(v.length).padStart(3)} 평균 ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}% 승률 ${win.toFixed(0)}%`;
};
for (const cat of ["허용", "차단"] as const) {
  const a = events.filter((e) => e.cat === cat);
  console.log(`  기존 규칙 ${cat} | 당일 마감 ${stats(a, "r0")} | 익일 마감 ${stats(a, "r1")}`);
}
console.log("  → 차단된 쪽이 허용된 쪽보다 나쁘지 않다. 고가권 차단은 성과를 지키지 못했다.");
console.log("\n  VWAP 이격별 (허용+차단 합산):");
for (const [lo, hi] of [
  [-99, 0],
  [0, 1],
  [1, CHASE_VWAP_PCT],
  [CHASE_VWAP_PCT, 99],
] as [number, number][]) {
  const a = events.filter((e) => e.vd != null && e.vd >= lo && e.vd < hi);
  console.log(`    VWAP ${String(lo).padStart(3)}~${String(hi).padStart(3)}% | 당일 ${stats(a, "r0")} | 익일 ${stats(a, "r1")}`);
}
console.log(`\n  새 규칙(RSI 72+ 또는 VWAP +${CHASE_VWAP_PCT}% 이상 → 눌림 지정가 대기)로 다시 나누면:`);
for (const nr of ["허용", "추격대기"] as const) {
  const a = events.filter((e) => e.newRule === nr);
  console.log(`    ${nr.padEnd(4)} | 당일 ${stats(a, "r0")} | 익일 ${stats(a, "r1")}`);
}
const flipped = events.filter((e) => e.cat === "차단" && e.newRule === "허용").length;
const nowWait = events.filter((e) => e.cat === "허용" && e.newRule === "추격대기").length;
console.log(`\n  기존에 차단됐다가 새 규칙에서 풀리는 신호: ${flipped}건 / 기존 허용이었다가 지정가 대기로 바뀌는 신호: ${nowWait}건`);
console.log("  정직한 한계: 표본이 작고(수십 건) 방향 예측력 자체는 AUC≈0.5(data/power-stats.json)다.");
console.log("  이 검증이 말하는 것은 ① 고가권 차단이 성과를 지키지 못했다 ② VWAP +1% 이상 위에서 산 신호는 '당일' 승률이");
console.log("  가장 낮았다(단타 기준 시장가 추격 불리)까지다. +2% 이상 구간의 '익일' 성과는 오히려 좋았으므로(추세 지속),");
console.log("  며칠 들고 갈 스윙이라면 이 규칙을 그대로 적용하면 안 된다 — 이 앱은 당일 청산 기준이라 지정가 대기를 택했다.");
