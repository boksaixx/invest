// 예상 경로(팬 차트) 검증 — 시간이 지날수록 벌어지는 구간이 실제 적중률을 내는지 확인한다.
//
// 실행: npx tsx scripts/validate-forecast-path.ts
//
// 검증 대상:
//  1. 다일 구간 커버리지 — D+1/D+2/D+3 시점의 90%·50% 구간이 실제로 그 비율만큼 맞는가.
//     차트가 "90% 범위"라고 표시하는데 실제 적중이 70%면 사용자를 오도하게 되므로 필수 검증.
//  2. √시간 스케일링 타당성 — h일 누적 변동폭이 정말 √h 배로 커지는지(랜덤워크 가정 점검).
//     실제 주가에 평균회귀나 추세지속이 있으면 이 가정이 깨진다.
//
// 미래 정보를 쓰지 않도록 각 시점에서 그때까지의 캔들만으로 예측하고 이후 실제와 대조한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forecastVolatility } from "../lib/volatility";
import type { Candle } from "../lib/types";

const KR = [
  { sym: "005930.KS", label: "삼성전자" },
  { sym: "000660.KS", label: "SK하이닉스" },
  { sym: "009150.KS", label: "삼성전기" },
  { sym: "042700.KS", label: "한미반도체" },
  { sym: "000990.KS", label: "DB하이텍" },
];
const EVAL_DAYS = 250;
const HORIZONS = [1, 2, 3];

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

function main() {
  const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;

  console.log("=== 예상 경로 구간 검증 (미래정보 없음, 최근 250거래일) ===");
  console.log("차트가 '90% 범위'로 표시하는 띠가 실제로 90% 맞는지 확인\n");

  const agg: Record<number, { n: number; in90: number; in50: number }> = {};
  for (const h of HORIZONS) agg[h] = { n: 0, in90: 0, in50: 0 };

  for (const { sym, label } of KR) {
    const candles = hist.symbols[sym]?.candles ?? [];
    if (candles.length < 300) continue;
    const per: Record<number, { n: number; in90: number; in50: number }> = {};
    for (const h of HORIZONS) per[h] = { n: 0, in90: 0, in50: 0 };

    const start = candles.length - EVAL_DAYS;
    for (let t = start; t < candles.length - Math.max(...HORIZONS); t++) {
      const window = candles.slice(0, t + 1);
      const vf = forecastVolatility(window, { applySox: false });
      if (!vf.available) continue;
      const base = candles[t].close;
      if (!(base > 0)) continue;
      for (const h of HORIZONS) {
        const future = candles[t + h];
        if (!future || !(future.close > 0)) continue;
        const actualPct = (future.close / base - 1) * 100;
        // 구간 폭은 √h 배로 확대 (lib/forecastPath.ts 와 동일한 규칙)
        const scale = Math.sqrt(h);
        const lo90 = vf.zQuantiles.q05 * vf.sigmaDailyPct * scale;
        const hi90 = vf.zQuantiles.q95 * vf.sigmaDailyPct * scale;
        const lo50 = vf.zQuantiles.q25 * vf.sigmaDailyPct * scale;
        const hi50 = vf.zQuantiles.q75 * vf.sigmaDailyPct * scale;
        per[h].n++;
        agg[h].n++;
        if (actualPct >= lo90 && actualPct <= hi90) {
          per[h].in90++;
          agg[h].in90++;
        }
        if (actualPct >= lo50 && actualPct <= hi50) {
          per[h].in50++;
          agg[h].in50++;
        }
      }
    }
    const parts = HORIZONS.map((h) => `D+${h} ${((per[h].in90 / per[h].n) * 100).toFixed(0)}%`).join(" / ");
    console.log(`${label.padEnd(10)} 90% 구간 적중: ${parts}`);
  }

  console.log("\n전체 합계");
  console.log("구간".padEnd(8) + "표본".padStart(6) + "90%구간 적중".padStart(14) + "50%구간 적중".padStart(14));
  for (const h of HORIZONS) {
    const a = agg[h];
    console.log(
      `D+${h}`.padEnd(8) +
        String(a.n).padStart(6) +
        `${((a.in90 / a.n) * 100).toFixed(1)}%`.padStart(14) +
        `${((a.in50 / a.n) * 100).toFixed(1)}%`.padStart(14),
    );
  }

  // √시간 스케일링 점검 — 실제 h일 변동성 ÷ (1일 변동성 × √h). 1에 가까울수록 랜덤워크 가정이 맞다.
  console.log("\n=== √시간 스케일링 타당성 (실제 h일 변동성 ÷ 이론값) ===");
  console.log("1.0이면 가정 정확 / 1보다 크면 추세지속(구간이 좁음) / 작으면 평균회귀(구간이 넓음)\n");
  for (const { sym, label } of KR) {
    const c = hist.symbols[sym]?.candles ?? [];
    if (c.length < 300) continue;
    const rets1: number[] = [];
    for (let i = c.length - EVAL_DAYS; i < c.length; i++) {
      if (c[i - 1].close > 0 && c[i].close > 0) rets1.push(Math.log(c[i].close / c[i - 1].close));
    }
    const sd1 = Math.sqrt(rets1.reduce((a, b) => a + b * b, 0) / rets1.length);
    const ratios = HORIZONS.map((h) => {
      const rh: number[] = [];
      for (let i = c.length - EVAL_DAYS; i < c.length - h; i++) {
        if (c[i].close > 0 && c[i + h].close > 0) rh.push(Math.log(c[i + h].close / c[i].close));
      }
      const sdh = Math.sqrt(rh.reduce((a, b) => a + b * b, 0) / rh.length);
      return `D+${h} ${(sdh / (sd1 * Math.sqrt(h))).toFixed(2)}`;
    });
    console.log(`${label.padEnd(10)} ${ratios.join("  ")}`);
  }

  console.log("\n해석 주의");
  console.log("- 이 검증은 '폭'이 맞는지만 본다. 방향(오를지 내릴지)은 예측하지 않는다.");
  console.log("- 1일 기준 경험분위수를 다일에 그대로 쓰므로, 다일 구간은 다소 넓게 나올 수 있다");
  console.log("  (여러 날이 겹치면 분포가 정규분포에 가까워져 꼬리가 얇아지기 때문).");
  console.log("- 장중 부분구간(예: 10시→마감)은 자체 로그 표본이 부족해 별도 검증하지 못했다.");
}

main();
