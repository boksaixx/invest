// 실전 성적표 — 자동수집 로그(data/log/*.json)에 남은 엔진 신호가 사후에 어땠는지 집계한다.
//
// 실행: npx tsx scripts/validate-live-signals.ts   (npm run scorecard)
//
// 왜 있나: 5년 백테스트(scripts/backtest.ts)는 일봉 기술점수만 재현한다. 실제 화면에 나간 신호는
// 장중·매크로·뉴스까지 섞인 종합 점수라 백테스트로는 검증이 안 된다. 15분마다 저장되는 로그에는
// 그 시각의 판단과 가격이 그대로 남아 있으므로, "앱이 사라고 한 시점에 샀다면" 당일 마감·익일
// 마감에 얼마였는지를 직접 잴 수 있다. 이 숫자가 나빠지면 규칙을 고쳐야 하고, 좋아졌다고
// 과신해도 안 된다(표본이 작다).
//
// 채점 기준: 같은 날 그 종목의 첫 신호(장초반/장중/점심)만 1건으로 센다. 손절·익절을 재현하지
// 않고 "마감가까지 들고 있었다면"만 잰다 — 실제 손절 규칙이 있으므로 최악의 손실은 실전이 더 작다.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CollectedSnapshot } from "../lib/types";

const LOG = join(process.cwd(), "data", "log");
type Row = { a: string; sc: number; b: boolean; p: number; ph: string; name: string; bs: number };
type Snap = { t: string; sig: Record<string, Row> };
const days: { date: string; snaps: Snap[] }[] = [];
for (const f of readdirSync(LOG).filter((f) => f.endsWith(".json")).sort()) {
  let arr: CollectedSnapshot[];
  try {
    arr = JSON.parse(readFileSync(join(LOG, f), "utf8"));
  } catch {
    continue;
  }
  days.push({
    date: f.slice(0, 10),
    snaps: arr
      .filter((s) => s.signals)
      .map((s) => ({
        t: s.collectedAt,
        sig: Object.fromEntries(
          s.signals!.map((x) => [x.ticker, { a: x.action, sc: x.score, b: x.entryBlocked, p: x.price, ph: x.marketPhase?.phase ?? "?", name: x.name, bs: x.buyStrength }]),
        ),
      })),
  });
}
const closeOf = (d: { snaps: Snap[] }, t: string) => {
  const last = [...d.snaps].reverse().find((s) => s.sig[t] && ["장마감", "동시호가", "마감임박"].includes(s.sig[t].ph));
  return last ? last.sig[t].p : null;
};

type Ev = { date: string; name: string; cat: string; ph: string; sc: number; r0: number; r1: number | null };
const events: Ev[] = [];
for (let i = 0; i < days.length; i++) {
  const d = days[i];
  const next = days[i + 1];
  const seen = new Set<string>();
  for (const s of d.snaps) {
    for (const [t, x] of Object.entries(s.sig)) {
      if (!["장초반", "장중", "점심시간대"].includes(x.ph) || seen.has(t)) continue;
      const cat = x.a === "신규매수" ? "신규매수" : x.b ? "진입차단" : x.sc >= 58 ? "매수근접(58~67)" : x.sc <= 32 ? "약세(≤32)" : null;
      if (!cat) continue;
      seen.add(t);
      const c0 = closeOf(d, t);
      const c1 = next ? closeOf(next, t) : null;
      if (c0 == null) continue;
      events.push({ date: d.date, name: x.name, cat, ph: x.ph, sc: x.sc, r0: (c0 / x.p - 1) * 100, r1: c1 ? (c1 / x.p - 1) * 100 : null });
    }
  }
}
const stats = (arr: Ev[], k: "r0" | "r1") => {
  const v = arr.map((a) => a[k]).filter((x): x is number => x != null);
  if (!v.length) return "n=  0";
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const win = (v.filter((x) => x > 0).length / v.length) * 100;
  const worst = Math.min(...v);
  return `n=${String(v.length).padStart(3)} 평균 ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}% 승률 ${win.toFixed(0).padStart(3)}% 최악 ${worst.toFixed(1)}%`;
};

console.log(`=== 실전 성적표: ${days[0]?.date} ~ ${days.at(-1)?.date} (${days.length}일, 로그 ${days.reduce((a, d) => a + d.snaps.length, 0)}회) ===`);
console.log("  '신호 시점 가격 → 당일 마감 / 익일 마감' 단순 보유 기준. 손절·익절 미반영.\n");
for (const cat of ["신규매수", "진입차단", "매수근접(58~67)", "약세(≤32)"]) {
  const a = events.filter((e) => e.cat === cat);
  console.log(`  ${cat.padEnd(12)} | 당일 ${stats(a, "r0")} | 익일 ${stats(a, "r1")}`);
}
console.log("\n  신규매수 — 발생 시간대별:");
for (const ph of ["장초반", "장중", "점심시간대"]) {
  const a = events.filter((e) => e.cat === "신규매수" && e.ph === ph);
  console.log(`    ${ph.padEnd(6)} | 당일 ${stats(a, "r0")} | 익일 ${stats(a, "r1")}`);
}
console.log("\n  신규매수 — 종목별 (당일 마감 기준):");
const names = [...new Set(events.filter((e) => e.cat === "신규매수").map((e) => e.name))];
for (const n of names) {
  const a = events.filter((e) => e.cat === "신규매수" && e.name === n);
  console.log(`    ${n.padEnd(10)} | ${stats(a, "r0")}`);
}
const buys = events.filter((e) => e.cat === "신규매수");
const win0 = buys.filter((e) => e.r0 > 0).length / Math.max(1, buys.length);
console.log(
  `\n  요약: 신규매수 ${buys.length}건 당일 승률 ${(win0 * 100).toFixed(0)}%. ` +
    (Math.abs(win0 - 0.5) < 0.08 ? "동전 던지기와 구분되지 않는다 — 점수는 '어디서/얼마나'를 정하는 데 쓰고, 방향 확신의 근거로 쓰지 말 것." : "기저율과 차이가 난다 — 표본이 더 쌓이면 재확인."),
);
console.log("  참고: data/power-stats.json — 5년 일봉에서 방향 예측 AUC 0.51(신뢰구간에 0.5 포함). 방향 예측은 없다고 보는 게 정직하다.");
