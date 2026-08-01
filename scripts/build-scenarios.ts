// 시나리오별 향후 수익률 분포 테이블 생성 → data/scenarios.json
//
// 실행: npx tsx scripts/build-scenarios.ts  (주간 백필 이후 함께 갱신)
//
// 왜 필요한가: "최근 6개월 보유 수익률"처럼 여러 장세를 뭉뚱그린 숫자는 미래 판단 근거가 될 수
// 없다. 코스피가 2배 오른 강세장 구간이 섞여 있으면 그 평균은 지금처럼 고점 대비 40~60%
// 폭락한 국면에 전혀 적용되지 않는다. 그래서 "지금과 비슷한 상태였던 과거 시점"만 골라
// 그 다음 5·20거래일에 실제로 무슨 일이 있었는지를 분포로 집계한다.
//
// 상태 분류에 쓰는 값은 전부 그 시점까지의 정보만 사용한다(미래 정보 없음).
//  - 60일 고점 대비 낙폭: 지금이 상승 추세인지 붕괴 국면인지 가르는 1차 축
//  - 변동성 분위: 같은 종목의 과거 변동성 대비 현재 위치(극단인지 평소인지)
//  - 60일 이동평균 상회 여부: 추세 방향
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyScenario, SCENARIO_FWD_HORIZONS } from "../lib/scenario";
import { CRASH_REBOUND_THRESHOLD_PCT } from "../lib/genius";
import type { Candle } from "../lib/types";

const KR = ["005930.KS", "000660.KS", "009150.KS", "042700.KS", "000990.KS"];
const MIN_HISTORY = 260; // 변동성 분위 계산에 필요한 최소 과거

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function main() {
  const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;
  const buckets: Record<string, Record<number, number[]>> = {};

  for (const sym of KR) {
    const c = hist.symbols[sym]?.candles ?? [];
    for (let t = MIN_HISTORY; t < c.length; t++) {
      const label = classifyScenario(c, t);
      if (!label) continue;
      buckets[label] = buckets[label] ?? Object.fromEntries(SCENARIO_FWD_HORIZONS.map((h) => [h, [] as number[]]));
      for (const f of SCENARIO_FWD_HORIZONS) {
        if (t + f < c.length && c[t].close > 0) buckets[label][f].push((c[t + f].close / c[t].close - 1) * 100);
      }
    }
  }

  const table: Record<string, Record<string, unknown>> = {};
  for (const [label, byHorizon] of Object.entries(buckets)) {
    const entry: Record<string, unknown> = {};
    for (const f of SCENARIO_FWD_HORIZONS) {
      const arr = [...byHorizon[f]].sort((a, b) => a - b);
      if (arr.length === 0) continue;
      entry[`d${f}`] = {
        n: arr.length,
        median: Number(quantile(arr, 0.5).toFixed(2)),
        p25: Number(quantile(arr, 0.25).toFixed(2)),
        p75: Number(quantile(arr, 0.75).toFixed(2)),
        lossProb: Number(((arr.filter((x) => x < 0).length / arr.length) * 100).toFixed(0)),
        crashProb: Number(((arr.filter((x) => x <= -20).length / arr.length) * 100).toFixed(0)),
        surgeProb: Number(((arr.filter((x) => x >= 20).length / arr.length) * 100).toFixed(0)),
      };
    }
    table[label] = entry;
  }

  // --- 플레이북 실적 통계 ---
  // 엔진이 사용자에게 인용하는 숫자("폭락 다음날 평균 +N%")를 코드에 하드코딩하면 데이터가
  // 갱신될 때 조용히 낡은 값을 말하게 된다. 실제로 7/31 데이터 반영 후 평균이 +1.4% → +0.75%로
  // 바뀐 사례가 있었다. 그래서 여기서 매번 다시 계산해 엔진이 읽어 쓰도록 한다.
  const ROUND_TRIP = 0.25;
  const crashRets: number[] = [];
  const surgeNextHigh: number[] = [];
  let surgeHit3 = 0;
  let surgeGapDown = 0;
  let surgeN = 0;
  for (const sym of KR) {
    const c = hist.symbols[sym]?.candles ?? [];
    for (let i = 1; i < c.length - 1; i++) {
      if (!(c[i - 1].close > 0 && c[i].close > 0)) continue;
      const chg = (c[i].close / c[i - 1].close - 1) * 100;
      if (chg <= CRASH_REBOUND_THRESHOLD_PCT) {
        crashRets.push((c[i + 1].close / c[i].close - 1) * 100 - ROUND_TRIP);
      }
      if (chg >= 12) {
        surgeN++;
        surgeNextHigh.push((c[i + 1].high / c[i].close - 1) * 100);
        if (c[i + 1].high >= c[i].close * 1.03) surgeHit3++;
        if (c[i + 1].open < c[i].close) surgeGapDown++;
      }
    }
  }
  const crashSorted = [...crashRets].sort((a, b) => a - b);
  const playbook = {
    crashRebound: {
      thresholdPct: CRASH_REBOUND_THRESHOLD_PCT,
      n: crashRets.length,
      avgNextDay: Number((crashRets.reduce((a, b) => a + b, 0) / Math.max(1, crashRets.length)).toFixed(2)),
      medianNextDay: Number(quantile(crashSorted, 0.5).toFixed(2)),
      winRate: Number(((crashRets.filter((x) => x > 0).length / Math.max(1, crashRets.length)) * 100).toFixed(0)),
      // 연속 폭락(익일에도 임계값 이하) 비율 — 소액 원칙의 근거
      consecutiveCrashPct: Number(
        ((crashRets.filter((_, k) => crashRets[k] <= CRASH_REBOUND_THRESHOLD_PCT).length / Math.max(1, crashRets.length)) * 100).toFixed(1),
      ),
    },
    surgeTakeProfit: {
      thresholdPct: 12,
      n: surgeN,
      avgNextHigh: Number((surgeNextHigh.reduce((a, b) => a + b, 0) / Math.max(1, surgeNextHigh.length)).toFixed(1)),
      hit3Pct: Number(((surgeHit3 / Math.max(1, surgeN)) * 100).toFixed(0)),
      gapDownPct: Number(((surgeGapDown / Math.max(1, surgeN)) * 100).toFixed(0)),
    },
  };

  const periodStart = hist.symbols[KR[0]].candles[0]?.date ?? "";
  const periodEnd = hist.symbols[KR[0]].candles.slice(-1)[0]?.date ?? "";
  const out = {
    generatedAt: new Date().toISOString(),
    periodStart,
    periodEnd,
    universe: "국내 반도체 5종목 (삼성전자·SK하이닉스·삼성전기·한미반도체·DB하이텍)",
    disclaimer:
      "같은 상태로 분류된 과거 시점들의 실제 향후 수익률 분포입니다. 미래 예측이 아니라 '과거에 이런 상태에서 무슨 일이 있었나'의 기록이며, 표본(n)이 작은 시나리오는 우연의 영향이 큽니다.",
    scenarios: table,
    playbook,
  };
  writeFileSync(join(process.cwd(), "data", "scenarios.json"), JSON.stringify(out, null, 1));

  console.log(`=== 시나리오 테이블 생성 (${periodStart} ~ ${periodEnd}) ===\n`);
  const rows = Object.entries(table).sort((a, b) => ((b[1].d20 as { n: number })?.n ?? 0) - ((a[1].d20 as { n: number })?.n ?? 0));
  console.log("시나리오".padEnd(32) + "표본".padStart(5) + "20일 중앙".padStart(11) + "하위25%".padStart(10) + "손실확률".padStart(9) + "-20%↓".padStart(8) + "+20%↑".padStart(8));
  for (const [label, e] of rows) {
    const d = e.d20 as { n: number; median: number; p25: number; lossProb: number; crashProb: number; surgeProb: number } | undefined;
    if (!d) continue;
    console.log(
      label.padEnd(30) +
        String(d.n).padStart(5) +
        `${d.median >= 0 ? "+" : ""}${d.median.toFixed(1)}%`.padStart(11) +
        `${d.p25 >= 0 ? "+" : ""}${d.p25.toFixed(1)}%`.padStart(10) +
        `${d.lossProb}%`.padStart(9) +
        `${d.crashProb}%`.padStart(8) +
        `${d.surgeProb}%`.padStart(8),
    );
  }
  console.log(`\n[플레이북 실적] 폭락반등(${playbook.crashRebound.thresholdPct}%↓): n=${playbook.crashRebound.n} 익일 평균 ${playbook.crashRebound.avgNextDay >= 0 ? "+" : ""}${playbook.crashRebound.avgNextDay}% 승률 ${playbook.crashRebound.winRate}%`);
  console.log(`[플레이북 실적] 급등익절(+12%↑): n=${playbook.surgeTakeProfit.n} 익일 고가 평균 +${playbook.surgeTakeProfit.avgNextHigh}% / +3% 도달 ${playbook.surgeTakeProfit.hit3Pct}% / 갭하락 ${playbook.surgeTakeProfit.gapDownPct}%`);
  console.log("\ndata/scenarios.json 저장 완료");
}

main();
