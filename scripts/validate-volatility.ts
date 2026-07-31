// 변동성 모델 검증 하니스 — data/market-history.json 5개년 실데이터로 lib/volatility.ts를 직접 검증한다.
//
// 실행: npx tsx scripts/validate-volatility.ts
//
// 중요: 이 스크립트는 모델을 재구현하지 않고 실제 배포되는 forecastVolatility()를 그대로 호출한다.
// 따라서 여기 나오는 성적표가 곧 실사용 성능이다. 모델을 수정하면 반드시 이 스크립트를 다시 돌려
// 성능이 떨어지지 않았는지 확인할 것.
//
// 평가 지표:
//  - 커버리지: "90% 구간"이라고 말한 구간에 실제 수익률이 들어간 비율. 90%에 가까울수록 정직한 추정.
//    90%보다 낮으면 위험 과소평가(더 위험), 높으면 과대평가(기회 손실).
//  - QLIKE: 변동성 예측 손실함수. 낮을수록 우수. 대안 모델과의 상대 비교용.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forecastVolatility, computePortfolioRisk } from "../lib/volatility";
import type { Candle } from "../lib/types";

const KR: { sym: string; label: string }[] = [
  { sym: "005930.KS", label: "삼성전자" },
  { sym: "000660.KS", label: "SK하이닉스" },
  { sym: "009150.KS", label: "삼성전기" },
  { sym: "042700.KS", label: "한미반도체" },
  { sym: "000990.KS", label: "DB하이텍" },
];

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

function load(): Hist {
  const p = join(process.cwd(), "data", "market-history.json");
  return JSON.parse(readFileSync(p, "utf8")) as Hist;
}

// 전일 미국장 SOX 등락률 조회 (국내 날짜 d 직전의 미국 거래일)
function soxLookup(candles: Candle[]) {
  const ret = new Map<string, number>();
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1].close;
    const c = candles[i].close;
    if (p > 0 && c > 0) ret.set(candles[i].date, Math.log(c / p) * 100);
  }
  const dates = candles.map((c) => c.date).sort();
  const cache = new Map<string, number | null>();
  return (d: string): number | null => {
    if (cache.has(d)) return cache.get(d)!;
    let best: string | null = null;
    for (const x of dates) {
      if (x < d && (!best || x > best)) best = x;
    }
    const v = best ? ret.get(best) ?? null : null;
    cache.set(d, v);
    return v;
  };
}

const EVAL_DAYS = 250; // 최근 250거래일(약 1년)에 대해 하루씩 앞으로 걸으며 검증

function main() {
  const hist = load();
  const soxCandles = hist.symbols["^SOX"]?.candles ?? [];
  const prevSox = soxLookup(soxCandles);

  console.log("=== 변동성 모델 검증 (lib/volatility.ts 실제 코드) ===");
  console.log(`검증 방식: 각 시점에서 그날까지의 데이터만으로 다음날을 예측 → 실제와 대조 (최근 ${EVAL_DAYS}거래일)\n`);

  let agg = { n: 0, in90: 0, in98: 0, up: 0, dn: 0 };
  const perStock: { label: string; sigma: number; ann: number; cov90: number; cov98: number; regime: string }[] = [];

  for (const { sym, label } of KR) {
    const candles = hist.symbols[sym]?.candles ?? [];
    if (candles.length < 300) {
      console.log(`${label}: 데이터 부족 (${candles.length}개) — 건너뜀`);
      continue;
    }
    let n = 0;
    let in90 = 0;
    let in98 = 0;
    let upExceed = 0;
    let dnExceed = 0;
    const start = candles.length - EVAL_DAYS;

    for (let t = start; t < candles.length - 1; t++) {
      const window = candles.slice(0, t + 1); // t시점까지의 정보만 사용 (미래 정보 차단)
      const next = candles[t + 1];
      const cur = candles[t];
      if (!(cur.close > 0 && next.close > 0)) continue;
      const actual = Math.log(next.close / cur.close) * 100;
      const f = forecastVolatility(window, { soxOvernightPct: prevSox(next.date), applySox: true });
      if (!f.available) continue;
      n++;
      if (actual >= f.range90.lowPct && actual <= f.range90.highPct) in90++;
      else if (actual > f.range90.highPct) upExceed++;
      else dnExceed++;
      if (actual >= f.range98.lowPct && actual <= f.range98.highPct) in98++;
    }

    const last = forecastVolatility(candles, { soxOvernightPct: prevSox(candles[candles.length - 1].date), applySox: true });
    perStock.push({
      label,
      sigma: last.sigmaDailyPct,
      ann: last.annualizedPct,
      cov90: (in90 / n) * 100,
      cov98: (in98 / n) * 100,
      regime: last.regime,
    });
    console.log(
      `${label.padEnd(10)} 90%구간 적중 ${((in90 / n) * 100).toFixed(1)}% (목표90) | 98%구간 적중 ${((in98 / n) * 100).toFixed(1)}% (목표98) | 상방초과 ${((upExceed / n) * 100).toFixed(1)}% 하방초과 ${((dnExceed / n) * 100).toFixed(1)}% (각 5%가 정상)`,
    );
    agg.n += n;
    agg.in90 += in90;
    agg.in98 += in98;
    agg.up += upExceed;
    agg.dn += dnExceed;
  }

  console.log(
    `\n${"전체".padEnd(10)} 90%구간 적중 ${((agg.in90 / agg.n) * 100).toFixed(1)}% | 98%구간 적중 ${((agg.in98 / agg.n) * 100).toFixed(1)}% | 상방초과 ${((agg.up / agg.n) * 100).toFixed(1)}% 하방초과 ${((agg.dn / agg.n) * 100).toFixed(1)}%`,
  );
  if (agg.up / agg.n > (agg.dn / agg.n) * 1.3) {
    console.log("→ 상방 초과가 하방보다 뚜렷이 많음: 급등(상한가) 쪽 꼬리가 더 두꺼운 국면. 공매도·조기 매도에 특히 불리.");
  }

  console.log("\n=== 현재 시점 변동성 추정 ===\n");
  for (const p of perStock) {
    console.log(`${p.label.padEnd(10)} 일간 ±${p.sigma.toFixed(2)}% (연율 ${p.ann.toFixed(0)}%) 레짐=${p.regime}`);
  }

  // 대안 모델 대비 우위 확인 (고정 변동성 / 120일 단순평균)
  console.log("\n=== 대안 모델 대비 (QLIKE, 낮을수록 우수) ===\n");
  const qlike = (actual: number, variance: number) => Math.log(variance) + (actual * actual) / variance;
  for (const { sym, label } of KR) {
    const candles = hist.symbols[sym]?.candles ?? [];
    if (candles.length < 300) continue;
    let qModel = 0;
    let qFixed = 0;
    let q120 = 0;
    let n = 0;
    const start = candles.length - EVAL_DAYS;
    for (let t = start; t < candles.length - 1; t++) {
      const window = candles.slice(0, t + 1);
      const next = candles[t + 1];
      const cur = candles[t];
      if (!(cur.close > 0 && next.close > 0)) continue;
      const actual = Math.log(next.close / cur.close) * 100;
      const f = forecastVolatility(window, { soxOvernightPct: prevSox(next.date), applySox: true });
      if (!f.available) continue;
      // 대안1: 전체기간 고정 변동성
      const allR: number[] = [];
      for (let i = 1; i <= t; i++) {
        const a = candles[i - 1].close;
        const b = candles[i].close;
        if (a > 0 && b > 0) allR.push(Math.log(b / a) * 100);
      }
      const vFixed = allR.reduce((a, b) => a + b * b, 0) / allR.length;
      // 대안2: 120일 단순평균 (구 volatilityRatio 방식과 유사)
      const w120 = allR.slice(-120);
      const v120 = w120.reduce((a, b) => a + b * b, 0) / w120.length;
      if (!(vFixed > 0 && v120 > 0)) continue;
      qModel += qlike(actual, f.sigmaDailyPct * f.sigmaDailyPct);
      qFixed += qlike(actual, vFixed);
      q120 += qlike(actual, v120);
      n++;
    }
    const better120 = ((q120 - qModel) / n).toFixed(3);
    console.log(
      `${label.padEnd(10)} 본모델=${(qModel / n).toFixed(3)} | 120일평균=${(q120 / n).toFixed(3)} | 고정=${(qFixed / n).toFixed(3)} → 120일평균 대비 ${Number(better120) > 0 ? "우수" : "열위"} (${better120})`,
    );
  }

  // 포트폴리오 위험 (사용자 실제 상황 예시: 2천만원 3종목 균등)
  console.log("\n=== 포트폴리오 위험 예시: 2천만원을 삼성전자·SK하이닉스·삼성전기에 균등 분산 ===\n");
  const CAP = 20_000_000;
  const positions = ["005930.KS", "000660.KS", "009150.KS"].map((s) => {
    const candles = hist.symbols[s].candles;
    const f = forecastVolatility(candles, { soxOvernightPct: prevSox(candles[candles.length - 1].date), applySox: true });
    return { name: hist.symbols[s].name, value: CAP / 3, candles, sigmaDailyPct: f.sigmaDailyPct };
  });
  const risk = computePortfolioRisk(positions);
  const won = (n: number) => `${(n / 10000).toFixed(0)}만원`;
  console.log(`포트폴리오 일간 변동성: ±${risk.sigmaDailyPct.toFixed(2)}% (${won(risk.sigmaDailyAmount)})`);
  console.log(`20일에 한 번 겪는 나쁜 날: ${won(risk.loss5Pct)} | 100일에 한 번 극단: ${won(risk.loss1Pct)}`);
  console.log(`실질 독립 종목수: ${risk.effectiveBets.toFixed(2)}개 (명목 3종목)`);
  console.log(`상관 무시 시 위험 과소평가: ${risk.naiveUnderestimatePct.toFixed(0)}%`);
  for (const w of risk.warnings) console.log(`  ⚠ ${w}`);

  // 실제 과거 최악의 날과 대조 (모델이 현실을 얼마나 담아내는가)
  console.log("\n=== 대조: 최근 6개월 실제로 가장 나빴던 날 ===\n");
  const syms = ["005930.KS", "000660.KS", "009150.KS"];
  const maps = syms.map((s) => {
    const m = new Map<string, number>();
    const c = hist.symbols[s].candles;
    for (let i = 1; i < c.length; i++) {
      if (c[i - 1].close > 0 && c[i].close > 0) m.set(c[i].date, (c[i].close / c[i - 1].close - 1) * 100);
    }
    return m;
  });
  const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d)) && d >= "2026-01-31").sort();
  const pnl = dates.map((d) => {
    const r = maps.reduce((a, m) => a + (m.get(d) as number) / 3, 0);
    return { d, amount: (r / 100) * CAP };
  });
  pnl.sort((a, b) => a.amount - b.amount);
  for (const p of pnl.slice(0, 3)) console.log(`  ${p.d}  실제 손익 ${won(p.amount)}`);
  console.log(`\n모델이 제시하는 "100일에 한 번" 손실 ${won(risk.loss1Pct)} 대비, 실제 최악은 ${won(pnl[0].amount)}`);
}

main();
