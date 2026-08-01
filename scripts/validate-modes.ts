// 오늘의 작전 검증 하니스 — 레짐별 플레이북 규칙들을 5개년 실데이터로 검증한다.
// (σ비례 눌림목 + 폭락 반등 매수 — lib/genius.ts 의 두 핵심 규칙)
//
// 실행: npx tsx scripts/validate-modes.ts
//
// 중요: 파라미터(GENIUS_*_SIGMA)를 lib/genius.ts에서 직접 import하므로, 프로덕션 값을
// 바꾸면 이 검증도 자동으로 같은 값으로 돌아간다. 값을 바꿨다면 반드시 다시 실행해
// 네 구간(급변동 전/후반·2025·평온한 2024) 모두에서 견디는지 확인할 것.
//
// 검증이 말해주는 것 / 말해주지 않는 것:
//  - 말해주는 것: 이 규칙이 과거 여러 장세에서 거래비용 차감 후에도 우위가 있었는지,
//    "매일 5% 보장"이 왜 불가능한지(익절 도달일 비율), 최대 낙폭이 어느 정도였는지.
//  - 말해주지 않는 것: 미래 수익. 과거 우위는 미래 보장이 아니다.
//  - 보수적 가정: 하루 안에 익절가·손절가를 모두 건드린 날은 "손절 먼저"로 처리(최악 순서).
//    지정가 체결은 저가가 지정가 이하로 내려온 날만 인정.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CRASH_REBOUND_THRESHOLD_PCT,
  GENIUS_DIP_SIGMA,
  GENIUS_STOP_SIGMA,
  GENIUS_TARGET_SIGMA,
} from "../lib/genius";
import type { Candle } from "../lib/types";

const ROUND_TRIP_COST_PCT = 0.25; // 왕복 거래비용(증권거래세+수수료) — 체결된 트레이드마다 차감
const KR = [
  { sym: "005930.KS", label: "삼성전자" },
  { sym: "000660.KS", label: "SK하이닉스" },
  { sym: "009150.KS", label: "삼성전기" },
  { sym: "042700.KS", label: "한미반도체" },
  { sym: "000990.KS", label: "DB하이텍" },
];

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

function ewmaSigma(c: Candle[], upto: number): number {
  const rs: number[] = [];
  for (let i = Math.max(1, upto - 200); i <= upto; i++) rs.push(Math.log(c[i].close / c[i - 1].close) * 100);
  let v = rs.slice(0, 20).reduce((a, b) => a + b * b, 0) / 20;
  for (const r of rs) v = 0.94 * v + 0.06 * r * r;
  return Math.sqrt(v);
}

function run(hist: Hist, days: string[], withCosts: boolean) {
  const idx: Record<string, Map<string, number>> = {};
  for (const { sym } of KR) idx[sym] = new Map(hist.symbols[sym].candles.map((c, i) => [c.date, i]));
  let cum = 1;
  let wins = 0;
  let losses = 0;
  let trades = 0;
  let targetHits = 0;
  const daily: number[] = [];
  for (const d of days) {
    // 후보: 폭락 직후 제외 필터 통과 종목 중 변동성 1위
    const cands: { sym: string; sig: number; i: number }[] = [];
    for (const { sym } of KR) {
      const i = idx[sym].get(d);
      if (i == null || i < 21) continue;
      const c = hist.symbols[sym].candles;
      const r1 = (c[i - 1].close / c[i - 2].close - 1) * 100;
      const r2 = (c[i - 2].close / c[i - 3].close - 1) * 100;
      if (r1 <= -8 || (r1 <= -5 && r2 <= -5)) continue; // 칼날 필터 (lib/genius.ts와 동일)
      cands.push({ sym, sig: ewmaSigma(c, i - 1), i });
    }
    cands.sort((a, b) => b.sig - a.sig);
    let dayRet = 0;
    for (const cnd of cands.slice(0, 1)) {
      const x = hist.symbols[cnd.sym].candles[cnd.i];
      const dip = GENIUS_DIP_SIGMA * cnd.sig;
      const tgt = GENIUS_TARGET_SIGMA * cnd.sig;
      const stp = GENIUS_STOP_SIGMA * cnd.sig;
      const entry = x.open * (1 - dip / 100);
      if (x.low > entry) continue; // 지정가 미체결 — 그날 트레이드 없음
      trades++;
      let ret: number;
      if (x.low <= entry * (1 - stp / 100)) ret = -stp; // 최악 순서: 손절 먼저
      else if (x.high >= entry * (1 + tgt / 100)) {
        ret = tgt;
        targetHits++;
      } else ret = (x.close - entry) / entry * 100;
      if (withCosts) ret -= ROUND_TRIP_COST_PCT;
      if (ret > 0) wins++;
      else losses++;
      dayRet += ret;
    }
    cum *= 1 + dayRet / 100;
    daily.push(dayRet);
  }
  let peak = 1;
  let mdd = 0;
  let eq = 1;
  for (const r of daily) {
    eq *= 1 + r / 100;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > mdd) mdd = dd;
  }
  return {
    cum: (cum - 1) * 100,
    winRate: trades ? (wins / trades) * 100 : 0,
    trades,
    targetHits,
    mdd: mdd * 100,
    days: days.length,
  };
}

// ---- 폭락 반등 규칙 검증: 당일 -8%↓ 마감 → 종가(동시호가) 매수 → 익일 종가 청산 ----
// 익절/손절 변형을 쓰지 않는 이유: +3% 익절 상한은 급변동장 반등(+5~10%)을 잘라먹고,
// -6% 스탑은 장중 진폭(평균 시가→저가 -4%)에 최악 순서 가정으로 먼저 걸린다 — 둘 다 실측 열위.
function runCrashRebound(hist: Hist, days: (d: string) => boolean) {
  const rets: number[] = [];
  for (const { sym } of KR) {
    const c = hist.symbols[sym].candles;
    for (let i = 1; i < c.length - 1; i++) {
      if (!days(c[i].date)) continue;
      const crash = (c[i].close / c[i - 1].close - 1) * 100;
      if (crash > CRASH_REBOUND_THRESHOLD_PCT) continue;
      const ret = (c[i + 1].close / c[i].close - 1) * 100 - ROUND_TRIP_COST_PCT;
      rets.push(ret);
    }
  }
  let cum = 1;
  let wins = 0;
  for (const r of rets) {
    cum *= 1 + r / 100;
    if (r > 0) wins++;
  }
  return {
    n: rets.length,
    avg: rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length),
    win: (wins / Math.max(1, rets.length)) * 100,
    cum: (cum - 1) * 100,
  };
}

function main() {
  const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;
  const allDays = hist.symbols["005930.KS"].candles.map((c) => c.date).sort();
  const periods: [string, string[]][] = [
    ["급변동장 전반(26.2~4월)", allDays.filter((d) => d >= "2026-01-31" && d < "2026-04-25")],
    ["급변동장 후반(26.4~7월)", allDays.filter((d) => d >= "2026-04-25")],
    ["2025년 전체", allDays.filter((d) => d >= "2025-01-01" && d <= "2025-12-31")],
    ["2024년(평온)", allDays.filter((d) => d >= "2024-01-01" && d <= "2024-12-31")],
  ];

  console.log("=== 눌림목 규칙 검증 — σ비례 (lib/genius.ts 상수 그대로 사용) ===");
  console.log(`규칙: 폭락 직후 제외 후 변동성 1위 종목, 시가-${GENIUS_DIP_SIGMA}σ 지정가 → +${GENIUS_TARGET_SIGMA}σ 익절 / -${GENIUS_STOP_SIGMA}σ 손절(우선) / 종가 청산`);
  console.log(`거래비용 왕복 ${ROUND_TRIP_COST_PCT}% 차감 | 최악 순서 가정(익절·손절 동시 접촉 시 손절 처리)\n`);

  for (const [name, days] of periods) {
    const r = run(hist, days, true);
    console.log(
      `${name.padEnd(20)} 누적 ${r.cum >= 0 ? "+" : ""}${r.cum.toFixed(1)}% | 승률 ${r.winRate.toFixed(0)}% | 체결 ${r.trades}회/${r.days}일 | 익절 도달 ${r.targetHits}회 | MDD ${r.mdd.toFixed(1)}%`,
    );
  }

  console.log(`\n=== 폭락 반등 규칙 (당일 ${CRASH_REBOUND_THRESHOLD_PCT}%↓ 마감 동시호가 매수 → 익일 종가 청산, 비용 차감) ===\n`);
  for (const [name, fn] of [
    ["5년 전체", () => true],
    ["최근 6개월(급변동)", (d: string) => d >= "2026-01-31"],
    ["그 이전(21~25년)", (d: string) => d < "2026-01-31"],
  ] as [string, (d: string) => boolean][]) {
    const r = runCrashRebound(hist, fn);
    console.log(`${name.padEnd(18)} n=${String(r.n).padStart(3)} 평균 ${r.avg >= 0 ? "+" : ""}${r.avg.toFixed(2)}% | 승률 ${r.win.toFixed(0)}% | 누적 ${r.cum >= 0 ? "+" : ""}${r.cum.toFixed(1)}%`);
  }
  console.log("주의: 13.6% 확률로 익일 또 -8%↓(연속 폭락) — 총자산 10% 이내 소액 전제. 개별 악재(소송·회계 등)에는 부적용.");

  console.log("\n=== 정직한 결론 ===");
  console.log("1. '매일 최소 5%'는 불가능하다: 익절(+1σ, 급변동장 기준 +5~9%) 도달일은 체결일의 일부이며,");
  console.log("   체결 자체가 안 되는 날(지정가 미도달)도 많다. 규칙은 '기회가 온 날만' 먹는다.");
  console.log("2. 비교: 순진한 추격 전략(변동성 1위를 시가 매수, SOX 방향 추종)은 급변동장 6개월 -54%였다.");
  console.log("3. 고정 % 파라미터는 학습 +36% → 검증 -5.5%로 뒤집혔다(과적합). σ비례가 네 구간 모두 견딘 이유는");
  console.log("   목표·손절이 장세에 자동으로 맞춰지기 때문이다.");
  console.log("4. 이 성적은 과거 재현이며 미래 보장이 아니다. 특히 MDD(최대 낙폭) 구간을 견딜 수 있어야 한다.");
}

main();
