// 유사 패턴(아날로그) 예측 검증 → data/analog-stats.json
//
// 실행: npx tsx scripts/validate-analog.ts
//
// 이 스크립트가 판정하는 것:
//  1. 방향 적중률 — "오른다/내린다"를 실제로 맞히는가. 기준선(항상 상승, 동전던지기)보다 나은가?
//  2. 확신도별 적중률 — 유사 사례의 상승 비율이 70% 이상일 때만 골랐다면 더 정확한가?
//     (그래야 "확신할 때만 말하는" 규칙을 만들 수 있다)
//  3. 구간 적중률 — 유사 사례 분포로 만든 80% 구간이 실제로 80% 맞는가.
//  4. 변수별 기여도 — 어떤 입력이 방향 예측에 실제로 도움이 됐는가.
//
// 워크포워드: 각 평가 시점에서 그보다 "과거 날짜"의 패턴만 후보로 쓴다. 같은 종목뿐 아니라
// 다른 종목의 과거도 쓰되, 날짜가 미래인 것은 절대 넣지 않는다.
//
// 결과 숫자는 코드에 하드코딩하지 않고 JSON으로 떨어뜨려 엔진/UI가 읽어 쓴다 —
// 데이터가 갱신될 때 앱이 조용히 낡은 숫자를 말하는 사고를 막기 위함이다.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFeatures, buildPatterns, findAnalogs, FEATURE_SPEC } from "../lib/analog";
import type { AnalogPattern } from "../lib/analog";
import type { Candle } from "../lib/types";

const KR = [
  { sym: "005930.KS", label: "삼성전자" },
  { sym: "000660.KS", label: "SK하이닉스" },
  { sym: "009150.KS", label: "삼성전기" },
  { sym: "042700.KS", label: "한미반도체" },
  { sym: "000990.KS", label: "DB하이텍" },
];
const EVAL_DAYS = 250; // 최근 250거래일을 평가 구간으로

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

function main() {
  const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;

  // SOX 날짜별 등락률
  const soxByDate = new Map<string, number>();
  const sox = hist.symbols["^SOX"]?.candles ?? [];
  for (let i = 1; i < sox.length; i++) {
    if (sox[i - 1].close > 0 && sox[i].close > 0) soxByDate.set(sox[i].date, (sox[i].close / sox[i - 1].close - 1) * 100);
  }

  // 전체 패턴 풀
  const allPatterns: AnalogPattern[] = [];
  for (const { sym, label } of KR) {
    const c = hist.symbols[sym]?.candles ?? [];
    if (c.length < 300) continue;
    allPatterns.push(...buildPatterns(sym, label, c, soxByDate));
  }
  console.log(`=== 유사 패턴 예측 검증 ===`);
  console.log(`전체 패턴 풀: ${allPatterns.length.toLocaleString()}개 (국내 반도체 5종목 × 5년)\n`);

  type Row = { conf: number; predUp: boolean; actualUp: boolean; actual: number; median: number; p10: number; p90: number; sim: number };
  const rows: Row[] = [];
  let skipped = 0;

  for (const { sym, label } of KR) {
    const c = hist.symbols[sym]?.candles ?? [];
    if (c.length < 300) continue;
    const start = c.length - EVAL_DAYS;
    for (let t = start; t < c.length - 1; t++) {
      const f = buildFeatures(c, t, soxByDate.get(c[t - 1].date) ?? 0);
      if (!f) continue;
      // 워크포워드: 평가 시점보다 과거 날짜의 패턴만 (같은 종목의 바로 직전도 제외되도록 날짜 비교)
      const cutoff = c[t].date;
      const pool = allPatterns.filter((p) => p.date < cutoff);
      const fc = findAnalogs(f, pool);
      if (!fc.available) {
        skipped++;
        continue;
      }
      const actual = (c[t + 1].close / c[t].close - 1) * 100;
      rows.push({
        conf: Math.max(fc.upProb, 100 - fc.upProb), // 어느 쪽이든 더 확신하는 정도
        predUp: fc.upProb >= 50,
        actualUp: actual > 0,
        actual,
        median: fc.medianPct,
        p10: fc.p10Pct,
        p90: fc.p90Pct,
        sim: fc.avgSimilarity,
      });
    }
    process.stdout.write(`  ${label} 평가 완료\n`);
  }

  if (rows.length === 0) {
    console.log("평가 가능한 표본이 없습니다.");
    return;
  }

  const hit = (r: Row) => r.predUp === r.actualUp;
  const acc = (arr: Row[]) => (arr.filter(hit).length / Math.max(1, arr.length)) * 100;

  // --- 1. 전체 방향 적중률 vs 기준선 ---
  const baseUp = (rows.filter((r) => r.actualUp).length / rows.length) * 100; // "항상 상승"이라고 찍었을 때의 적중률
  const alwaysMajority = Math.max(baseUp, 100 - baseUp); // 더 흔한 쪽으로만 찍는 최선의 무지성 전략
  console.log(`\n■ 방향 적중률 (표본 ${rows.length}건, 판단보류 ${skipped}건)`);
  console.log(`  아날로그 모델      ${acc(rows).toFixed(1)}%`);
  console.log(`  기준선(항상 상승)  ${baseUp.toFixed(1)}%`);
  console.log(`  기준선(다수쪽 고정) ${alwaysMajority.toFixed(1)}%  ← 이걸 못 넘으면 예측 가치 없음`);

  // --- 2. 확신도 구간별 ---
  console.log(`\n■ 확신도(유사 사례 중 한쪽 비율)별 적중률`);
  console.log("  확신도".padEnd(14) + "표본".padStart(8) + "적중률".padStart(10) + "평균 실제등락".padStart(14));
  const bands: [number, number][] = [
    [50, 55],
    [55, 60],
    [60, 65],
    [65, 70],
    [70, 101],
  ];
  const confStats: { min: number; max: number; n: number; acc: number; avgAbs: number }[] = [];
  for (const [lo, hi] of bands) {
    const sub = rows.filter((r) => r.conf >= lo && r.conf < hi);
    if (sub.length === 0) continue;
    const a = acc(sub);
    const avgSigned = sub.reduce((s, r) => s + (r.predUp ? r.actual : -r.actual), 0) / sub.length;
    confStats.push({ min: lo, max: hi, n: sub.length, acc: a, avgAbs: avgSigned });
    console.log(
      `  ${lo}~${hi === 101 ? "100" : hi}%`.padEnd(14) +
        String(sub.length).padStart(8) +
        `${a.toFixed(1)}%`.padStart(10) +
        `${avgSigned >= 0 ? "+" : ""}${avgSigned.toFixed(2)}%`.padStart(14),
    );
  }
  console.log("  (평균 실제등락 = 예측 방향대로 잡았을 때의 평균 수익률. 양수여야 쓸모 있음)");

  // --- 3. 구간 적중률 ---
  const in80 = rows.filter((r) => r.actual >= r.p10 && r.actual <= r.p90).length / rows.length;
  const medianAbsErr = [...rows].map((r) => Math.abs(r.actual - r.median)).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  console.log(`\n■ 구간·크기 예측`);
  console.log(`  80% 구간(하위10~상위90) 실제 적중률: ${(in80 * 100).toFixed(1)}%  (목표 80%)`);
  console.log(`  중앙값 예측의 절대오차 중앙값: ${medianAbsErr.toFixed(2)}%p`);

  // --- 4. 변수별 기여도 (해당 변수를 지웠을 때 적중률이 얼마나 떨어지나) ---
  console.log(`\n■ 변수별 기여도 (그 변수를 빼고 다시 매칭했을 때의 적중률 변화)`);
  console.log("  변수".padEnd(28) + "제거 시 적중률".padStart(14) + "기여".padStart(10));
  const fullAcc = acc(rows);
  const ablation: { key: string; label: string; accWithout: number; delta: number }[] = [];
  // 계산량이 크므로 표본을 줄여서 측정 (동일 표본으로 비교하므로 상대 비교는 유효)
  const sampleIdx = rows.map((_, i) => i).filter((i) => i % 3 === 0);
  for (const { key, label } of FEATURE_SPEC) {
    let n = 0;
    let h = 0;
    let si = 0;
    for (const { sym } of KR) {
      const c = hist.symbols[sym]?.candles ?? [];
      if (c.length < 300) continue;
      const start = c.length - EVAL_DAYS;
      for (let t = start; t < c.length - 1; t++) {
        if (si++ % 3 !== 0) continue;
        const f = buildFeatures(c, t, soxByDate.get(c[t - 1].date) ?? 0);
        if (!f) continue;
        const cutoff = c[t].date;
        const pool = allPatterns.filter((p) => p.date < cutoff);
        // 해당 축을 양쪽 모두 0으로 만들어 거리 계산에서 무력화
        const f2 = { ...f, [key]: 0 };
        const pool2 = pool.map((p) => ({ ...p, f: { ...p.f, [key]: 0 } }));
        const fc = findAnalogs(f2, pool2);
        if (!fc.available) continue;
        const actual = (c[t + 1].close / c[t].close - 1) * 100;
        n++;
        if (fc.upProb >= 50 === actual > 0) h++;
      }
    }
    const a = n > 0 ? (h / n) * 100 : NaN;
    ablation.push({ key, label, accWithout: a, delta: fullAcc - a });
  }
  // 같은 축소 표본에서의 전체 적중률(비교 기준)
  const sampleFullAcc = acc(sampleIdx.map((i) => rows[i]));
  for (const a of ablation.sort((x, y) => y.delta - x.delta)) {
    console.log(
      `  ${a.label}`.padEnd(28) +
        `${isNaN(a.accWithout) ? "-" : a.accWithout.toFixed(1) + "%"}`.padStart(14) +
        `${(sampleFullAcc - a.accWithout >= 0 ? "+" : "") + (sampleFullAcc - a.accWithout).toFixed(1)}%p`.padStart(10),
    );
  }
  console.log(`  (축소표본 기준 전체 적중률 ${sampleFullAcc.toFixed(1)}% — 위 값과 비교)`);

  // --- 저장 ---
  const out = {
    generatedAt: new Date().toISOString(),
    poolSize: allPatterns.length,
    evalDays: EVAL_DAYS,
    sample: rows.length,
    skipped,
    accuracyPct: Number(fullAcc.toFixed(1)),
    baselineAlwaysUpPct: Number(baseUp.toFixed(1)),
    baselineMajorityPct: Number(alwaysMajority.toFixed(1)),
    band80CoveragePct: Number((in80 * 100).toFixed(1)),
    medianAbsErrorPct: Number(medianAbsErr.toFixed(2)),
    byConfidence: confStats.map((c) => ({
      minConf: c.min,
      maxConf: c.max === 101 ? 100 : c.max,
      n: c.n,
      accuracyPct: Number(c.acc.toFixed(1)),
      avgSignedRetPct: Number(c.avgAbs.toFixed(2)),
    })),
    featureContribution: ablation
      .map((a) => ({ key: a.key, label: a.label, accWithoutPct: Number(a.accWithout.toFixed(1)), deltaPct: Number((sampleFullAcc - a.accWithout).toFixed(1)) }))
      .sort((a, b) => b.deltaPct - a.deltaPct),
    disclaimer:
      "워크포워드(미래정보 미사용) 실측값입니다. 방향 예측은 확률이지 보장이 아니며, 기준선 대비 우위가 작으면 그만큼 신중하게 써야 합니다.",
  };
  writeFileSync(join(process.cwd(), "data", "analog-stats.json"), JSON.stringify(out, null, 1));
  console.log(`\ndata/analog-stats.json 저장 완료`);

  // --- 판정 ---
  console.log(`\n■ 판정`);
  const edge = fullAcc - alwaysMajority;
  if (edge <= 0) {
    console.log(`  ❌ 기준선을 못 넘었다(${edge.toFixed(1)}%p). 방향 예측을 사용자에게 제시하면 안 된다.`);
  } else if (edge < 2) {
    console.log(`  ⚠️ 기준선 대비 +${edge.toFixed(1)}%p — 우위가 미미하다. 확신도 높은 구간에서만 방향을 말해야 한다.`);
  } else {
    console.log(`  ✅ 기준선 대비 +${edge.toFixed(1)}%p — 방향 제시에 근거가 있다. 단 확률로만 말할 것.`);
  }
}

main();
