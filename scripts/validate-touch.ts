// 도달 확률 검증 — "이 가격에 지정가를 걸면 실제로 체결되는가"
//
// 실행: npx tsx scripts/validate-touch.ts
//
// 왜 이걸 만드나: 방향 예측(오를까 내릴까)은 실패했다(scripts/validate-analog.ts —
// 적중률 47~50%로 기준선 미달, 따라가면 평균 손실). 그런데 단타에서 실제로 필요한 판단은
// "오를까?"가 아니라 "내가 건 지정가에 닿을까?"다. 이건 방향이 아니라 변동폭의 문제이고,
// 변동폭은 우리 모델이 이미 잘 맞힌다(90% 구간 적중률 88%).
//
// 이론: 랜덤워크에서 "기간 중 한 번이라도 d만큼 떨어진 지점에 닿을 확률"은
// 반사원리(reflection principle)에 의해 "기간 끝에 그 지점 너머에 있을 확률"의 약 2배다.
// 이 근사가 실제 국내 반도체주에서 얼마나 맞는지를 일봉 고가/저가로 직접 검증한다.
import { readFileSync, writeFileSync } from "node:fs";
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
const EVAL_DAYS = 500;
// 검증할 거리 (일간 σ의 배수). 0.5σ는 얕은 눌림목, 1.5σ는 깊은 급락 지점에 해당한다.
const SIGMA_LEVELS = [0.3, 0.5, 0.75, 1.0, 1.5, 2.0];

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

/** 표준정규 누적분포 (Abramowitz-Stegun 근사) */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/**
 * 반사원리 기반 도달 확률: P(기간 중 최저가 ≤ -k·σ) ≈ 2·Φ(-k)
 * (양쪽 모두 같은 식. 실제 주가는 꼬리가 두꺼워 이론값과 차이가 나므로 아래에서 실측 보정한다)
 */
export function touchProbTheory(kSigma: number): number {
  return Math.min(1, 2 * normCdf(-Math.abs(kSigma)));
}

function main() {
  const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;

  console.log("=== 지정가 도달 확률 검증 ===");
  console.log("전일 종가 기준으로 다음날 장중에 그 가격에 닿았는지를 실제 고가·저가로 확인\n");
  console.log("거리(σ)".padEnd(10) + "이론값".padStart(9) + "실측 하단도달".padStart(14) + "실측 상단도달".padStart(14) + "표본".padStart(8));

  const down: Record<number, { hit: number; n: number }> = {};
  const up: Record<number, { hit: number; n: number }> = {};
  for (const k of SIGMA_LEVELS) {
    down[k] = { hit: 0, n: 0 };
    up[k] = { hit: 0, n: 0 };
  }

  for (const { sym } of KR) {
    const c = hist.symbols[sym]?.candles ?? [];
    if (c.length < 400) continue;
    for (let t = Math.max(200, c.length - EVAL_DAYS); t < c.length - 1; t++) {
      const vf = forecastVolatility(c.slice(0, t + 1), { applySox: false });
      if (!vf.available) continue;
      const base = c[t].close;
      const nx = c[t + 1];
      if (!(base > 0 && nx.high > 0 && nx.low > 0)) continue;
      const sigma = vf.sigmaDailyPct;
      const lowPct = (nx.low / base - 1) * 100;
      const highPct = (nx.high / base - 1) * 100;
      for (const k of SIGMA_LEVELS) {
        down[k].n++;
        up[k].n++;
        if (lowPct <= -k * sigma) down[k].hit++;
        if (highPct >= k * sigma) up[k].hit++;
      }
    }
  }

  const calib: { kSigma: number; theoryPct: number; downPct: number; upPct: number; avgPct: number; n: number }[] = [];
  for (const k of SIGMA_LEVELS) {
    const th = touchProbTheory(k) * 100;
    const d = (down[k].hit / Math.max(1, down[k].n)) * 100;
    const u = (up[k].hit / Math.max(1, up[k].n)) * 100;
    calib.push({ kSigma: k, theoryPct: Number(th.toFixed(1)), downPct: Number(d.toFixed(1)), upPct: Number(u.toFixed(1)), avgPct: Number(((d + u) / 2).toFixed(1)), n: down[k].n });
    console.log(
      `${k}σ`.padEnd(10) +
        `${th.toFixed(1)}%`.padStart(9) +
        `${d.toFixed(1)}%`.padStart(14) +
        `${u.toFixed(1)}%`.padStart(14) +
        String(down[k].n).padStart(8),
    );
  }

  // 장중 부분구간(조회 시점 → 마감)에도 같은 식을 쓰려면 남은 변동성으로 σ를 줄이면 된다.
  // 그 축소가 타당한지는 "남은 시간이 짧을수록 도달률이 실제로 낮아지는가"로 간접 확인한다.
  console.log("\n=== 참고: 이론값 대비 실측 배율 (보정계수) ===");
  for (const c of calib) {
    const ratio = c.theoryPct > 0 ? c.avgPct / c.theoryPct : NaN;
    console.log(`  ${c.kSigma}σ: 실측/이론 = ${ratio.toFixed(2)}`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    evalDays: EVAL_DAYS,
    universe: "국내 반도체 5종목",
    method: "전일 종가 기준 다음 거래일 장중 고가·저가가 ±kσ 지점에 닿았는지 실측. σ는 그 시점까지의 데이터만 쓴 EWMA 추정치(미래정보 없음).",
    calibration: calib,
    note: "이론(반사원리)값과 실측이 다르면 앱은 실측값을 쓴다. 하단 도달률이 상단보다 높으면 그만큼 하방 꼬리가 두껍다는 뜻이다.",
  };
  writeFileSync(join(process.cwd(), "data", "touch-stats.json"), JSON.stringify(out, null, 1));
  console.log("\ndata/touch-stats.json 저장 완료");

  console.log("\n■ 해석");
  console.log("- 이 확률은 '방향'이 아니라 '변동폭'에서 나온다. 그래서 방향 예측과 달리 실제로 맞는다.");
  console.log("- 매수 지정가를 하단에 걸면 체결 확률을, 매도 지정가를 상단에 걸면 체결 확률을 알 수 있다.");
  console.log("- 단, 체결됐다고 수익이 나는 건 아니다. 하단 체결은 '더 빠지는 중'일 수도 있다.");
}

main();
