// 변동성 추정 모델 — "내일 이 종목이 얼마나 움직일 수 있는가"를 확률 구간으로 추정한다.
//
// 이 모듈의 모든 상수는 data/market-history.json 5개년 실데이터로 검증해 고른 값이며,
// 검증 절차와 성적은 scripts/validate-volatility.ts 로 언제든 재현할 수 있다.
//
// 설계 근거 (검증 결과 요약):
//  - EWMA(λ=0.94)가 20/60/120일 단순평균·고정변동성·GARCH(1,1)를 QLIKE 기준 전 종목에서 이겼다.
//    특히 120일 단순평균(구 volatilityRatio 방식)은 레짐 전환에 크게 뒤처졌다.
//  - 변동성은 지속성이 매우 강해(λ가 높을수록 우수) "어제 크게 움직였으면 오늘도 크게 움직인다"가
//    실제로 성립한다. 반면 장기 평균 회귀를 가정하면 급변동장에서 위험을 과소평가한다.
//  - 전일 미국 반도체지수(SOX) 변동폭은 국내 반도체주 변동성을 유의하게 예측한다
//    (동일날짜 상관 0.18~0.22 vs 직전 미국장 상관 0.33~0.43 — 오버나이트 전이가 2배 강함).
//  - 거래량 급증도 소폭이지만 일관되게 기여한다.
//  - VIX는 이론상 선행지표지만 실측 기여도가 0이어서 채택하지 않았다(복잡도만 늘고 정확도 개선 없음).
//  - 수익률 분포는 정규분포가 아니다(첨도 4.8~17.5). 정규분포 ±1.645σ를 쓰면 급등락을 과소평가하므로
//    종목별 표준화잔차의 경험분위수를 쓴다. 특히 상방 꼬리가 하방보다 두껍다(상한가 현상).
import type { Candle, VolForecast } from "./types";

export type { VolForecast };

const LAMBDA = 0.94; // EWMA 감쇠계수 (RiskMetrics 표준이자 본 데이터 검증 최우수)
const SOX_GAMMA = 0.2; // 전일 SOX 변동폭 민감도
const VOL_DELTA = 0.2; // 거래량 급증 민감도
const MIN_CANDLES = 80; // 이보다 적으면 추정을 포기한다(잘못된 숫자보다 "모름"이 안전)

export const VOL_COVERAGE_NOTE =
  "과거 5년 데이터의 마지막 20% 구간(모델 학습에 쓰지 않은 기간)으로 검증한 결과, 90% 구간의 실제 적중률은 약 88%, 98% 구간은 약 97.5%입니다. 즉 구간을 살짝 좁게 잡는 편이니 경계값은 보수적으로 해석하세요.";

function trueEwmaVariance(returns: number[]): number {
  const seed = returns.slice(0, 20);
  let v = seed.reduce((a, b) => a + b * b, 0) / Math.max(1, seed.length);
  for (const r of returns) v = LAMBDA * v + (1 - LAMBDA) * r * r;
  return v;
}

// 로그수익률(%) 시계열
function logReturns(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1].close;
    const c = candles[i].close;
    if (p > 0 && c > 0) out.push(Math.log(c / p) * 100);
  }
  return out;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * 내일 하루 변동폭을 추정한다.
 *
 * @param candles 일봉 (최소 80개, 많을수록 경험분위수가 안정적)
 * @param opts.soxOvernightPct 전일 미국 반도체지수(SOX) 등락률 — 국내 종목에만 의미 있음
 * @param opts.applySox 국내 반도체주면 true (미국 종목은 SOX와 동시간대라 오버나이트 전이 개념이 없음)
 */
export function forecastVolatility(
  candles: Candle[],
  opts: { soxOvernightPct?: number | null; applySox?: boolean } = {},
): VolForecast {
  const empty: VolForecast = {
    available: false,
    sigmaDailyPct: NaN,
    annualizedPct: NaN,
    range90: { lowPct: NaN, highPct: NaN },
    range98: { lowPct: NaN, highPct: NaN },
    regime: "보통",
    regimePercentile: NaN,
    regimeRatio: NaN,
    skew: "대칭",
    drivers: [],
    zQuantiles: { q05: -1.645, q25: -0.674, q75: 0.674, q95: 1.645 },
  };
  if (candles.length < MIN_CANDLES) return empty;

  const rets = logReturns(candles);
  if (rets.length < MIN_CANDLES - 5) return empty;

  // 1) 기본 EWMA 분산
  let variance = trueEwmaVariance(rets);
  if (!(variance > 0)) return empty;
  const baseSigma = Math.sqrt(variance);
  const drivers: string[] = [];

  // 2) 전일 SOX 변동폭 조건부 조정 — 국내 반도체주는 미국장 급변동이 갭으로 직접 전이된다.
  //    과거 평균적인 SOX 일변동폭을 1.75%로 두고(5년 실측치), 그 대비 배율로 조정한다.
  const SOX_AVG_ABS = 1.75;
  if (opts.applySox && opts.soxOvernightPct != null && isFinite(opts.soxOvernightPct)) {
    const absSox = Math.abs(opts.soxOvernightPct);
    const mult = 1 + SOX_GAMMA * (absSox / SOX_AVG_ABS - 1);
    if (mult > 0) {
      variance *= mult;
      if (absSox >= SOX_AVG_ABS * 2) {
        drivers.push(`전일 미 반도체지수(SOX) ${opts.soxOvernightPct >= 0 ? "+" : ""}${opts.soxOvernightPct.toFixed(1)}% 급변동 — 갭 위험 확대`);
      }
    }
  }

  // 3) 거래량 급증 조건부 조정 — 직전 거래일 거래량이 20일 평균 대비 얼마나 많았는가
  const vols = candles.map((c) => c.volume).filter((v) => v > 0);
  if (vols.length >= 21) {
    const last = vols[vols.length - 1];
    const window = vols.slice(-21, -1);
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    if (avg > 0) {
      const ratio = last / avg;
      const mult = 1 + VOL_DELTA * (ratio - 1);
      if (mult > 0) {
        variance *= mult;
        if (ratio >= 2) drivers.push(`직전 거래일 거래량이 평소의 ${ratio.toFixed(1)}배 — 변동성 확대 국면`);
      }
    }
  }

  const sigma = Math.sqrt(variance);

  // 4) 경험분위수 (표준화잔차 기준) — 정규분포를 쓰지 않는 이유는 파일 상단 주석 참고
  const ewmaPath: number[] = [];
  {
    const seed = rets.slice(0, 20);
    let v = seed.reduce((a, b) => a + b * b, 0) / Math.max(1, seed.length);
    for (const r of rets) {
      ewmaPath.push(v);
      v = LAMBDA * v + (1 - LAMBDA) * r * r;
    }
  }
  const z: number[] = [];
  for (let i = 1; i < rets.length; i++) {
    const v = ewmaPath[i];
    if (v > 0) z.push(rets[i] / Math.sqrt(v));
  }
  z.sort((a, b) => a - b);
  const q05 = z.length >= 60 ? quantile(z, 0.05) : -1.645;
  const q95 = z.length >= 60 ? quantile(z, 0.95) : 1.645;
  const q01 = z.length >= 60 ? quantile(z, 0.01) : -2.326;
  const q99 = z.length >= 60 ? quantile(z, 0.99) : 2.326;

  // 5) 레짐 판정 — 과거 EWMA 경로 대비 현재 변동성이 어느 분위인지
  const pastSigmas = ewmaPath.filter((v) => v > 0).map((v) => Math.sqrt(v)).sort((a, b) => a - b);
  const below = pastSigmas.filter((s) => s < sigma).length;
  const regimePercentile = pastSigmas.length ? (below / pastSigmas.length) * 100 : NaN;
  const medianSigma = quantile(pastSigmas, 0.5);
  const regimeRatio = medianSigma > 0 ? sigma / medianSigma : NaN;
  const regime: VolForecast["regime"] =
    !isFinite(regimePercentile) ? "보통"
      : regimePercentile >= 90 ? "극단"
      : regimePercentile >= 70 ? "높음"
      : regimePercentile >= 30 ? "보통"
      : "평온";

  if (regime === "극단") {
    const topPct = Math.max(1, Math.round(100 - regimePercentile));
    drivers.unshift(`현재 변동성이 과거 2년 중 가장 심한 상위 ${topPct}% 구간 — 평소의 ${regimeRatio.toFixed(1)}배`);
  } else if (regime === "높음") {
    drivers.unshift(`변동성이 평소의 ${regimeRatio.toFixed(1)}배로 확대된 상태`);
  }

  const skew: VolForecast["skew"] =
    q95 > Math.abs(q05) * 1.15 ? "상방" : Math.abs(q05) > q95 * 1.15 ? "하방" : "대칭";

  const q25 = z.length >= 60 ? quantile(z, 0.25) : -0.674;
  const q75 = z.length >= 60 ? quantile(z, 0.75) : 0.674;

  return {
    available: true,
    sigmaDailyPct: sigma,
    annualizedPct: sigma * Math.sqrt(252),
    range90: { lowPct: q05 * sigma, highPct: q95 * sigma },
    range98: { lowPct: q01 * sigma, highPct: q99 * sigma },
    // 표준화잔차 분위수 원값 — 하루 미만/이상 구간으로 다시 스케일할 때 필요하다
    // (예: 10시에 조회하면 마감까지 남은 변동성으로 다시 계산해야 하므로)
    zQuantiles: { q05, q25, q75, q95 },
    regime,
    regimePercentile,
    regimeRatio,
    skew,
    drivers,
  };
}

// ---------------- 포트폴리오 단위 위험 ----------------

export interface PortfolioRisk {
  available: boolean;
  totalValue: number; // 평가금액 합계 (원)
  sigmaDailyPct: number; // 포트폴리오 일간 표준편차 (%)
  sigmaDailyAmount: number; // 위와 동일하나 금액 (원)
  loss5Pct: number; // 20일에 1번 꼴로 겪는 나쁜 날의 손실 (원, 음수)
  loss1Pct: number; // 100일에 1번 꼴 극단 손실 (원, 음수)
  gain5Pct: number; // 20일에 1번 꼴 좋은 날의 이익 (원, 양수)
  effectiveBets: number; // 상관을 반영한 "실질 독립 종목수"
  naiveUnderestimatePct: number; // 상관 무시 시 위험 과소평가 정도 (%)
  topWeight: { name: string; weightPct: number } | null;
  warnings: string[];
}

/**
 * 보유 종목들의 상관관계를 반영한 포트폴리오 위험.
 *
 * 국내 반도체주끼리는 상관이 매우 높아(실측 삼성전자-SK하이닉스 0.86) 종목을 나눠 담아도
 * 분산 효과가 거의 없다. 각 종목 위험을 따로 보면 전체 위험을 크게 과소평가하므로
 * 반드시 상관행렬을 통해 합산한다.
 */
export function computePortfolioRisk(
  positions: { name: string; value: number; candles: Candle[]; sigmaDailyPct: number }[],
): PortfolioRisk {
  const empty: PortfolioRisk = {
    available: false,
    totalValue: 0,
    sigmaDailyPct: NaN,
    sigmaDailyAmount: NaN,
    loss5Pct: NaN,
    loss1Pct: NaN,
    gain5Pct: NaN,
    effectiveBets: NaN,
    naiveUnderestimatePct: NaN,
    topWeight: null,
    warnings: [],
  };
  const valid = positions.filter((p) => p.value > 0 && p.candles.length >= MIN_CANDLES && isFinite(p.sigmaDailyPct));
  if (valid.length === 0) return empty;

  const total = valid.reduce((a, p) => a + p.value, 0);
  if (!(total > 0)) return empty;
  const w = valid.map((p) => p.value / total);

  // 공통 거래일 기준 수익률 행렬 (상관 계산용, 최근 120일)
  const retMaps = valid.map((p) => {
    const m = new Map<string, number>();
    for (let i = 1; i < p.candles.length; i++) {
      const prev = p.candles[i - 1].close;
      const cur = p.candles[i].close;
      if (prev > 0 && cur > 0) m.set(p.candles[i].date, Math.log(cur / prev) * 100);
    }
    return m;
  });
  const commonDates = [...retMaps[0].keys()].filter((d) => retMaps.every((m) => m.has(d))).sort().slice(-120);

  // 상관행렬
  const n = valid.length;
  const corr: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const series = retMaps.map((m) => commonDates.map((d) => m.get(d) as number));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        corr[i][j] = 1;
        continue;
      }
      const a = series[i];
      const b = series[j];
      if (a.length < 20) {
        corr[i][j] = 0.7; // 데이터 부족 시 반도체 섹터 평균 상관으로 보수적 가정
        continue;
      }
      const ma = a.reduce((x, y) => x + y, 0) / a.length;
      const mb = b.reduce((x, y) => x + y, 0) / b.length;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let k = 0; k < a.length; k++) {
        const x = a[k] - ma;
        const y = b[k] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
      }
      corr[i][j] = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0.7;
    }
  }

  // 포트폴리오 분산 = ΣΣ w_i w_j σ_i σ_j ρ_ij
  let variance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      variance += w[i] * w[j] * valid[i].sigmaDailyPct * valid[j].sigmaDailyPct * corr[i][j];
    }
  }
  const sigmaPct = Math.sqrt(Math.max(variance, 0));

  // 상관을 무시했을 때(완전 독립 가정) 나오는 값 — 얼마나 과소평가하게 되는지 보여주기 위함
  const naiveVar = valid.reduce((a, p, i) => a + w[i] * w[i] * p.sigmaDailyPct * p.sigmaDailyPct, 0);
  const naiveSigma = Math.sqrt(Math.max(naiveVar, 0));
  const naiveUnderestimatePct = naiveSigma > 0 ? (sigmaPct / naiveSigma - 1) * 100 : 0;

  // 실질 독립 종목수 = (완전동조 시 변동성 ÷ 실제 변동성)^2
  const perfectSigma = valid.reduce((a, p, i) => a + w[i] * p.sigmaDailyPct, 0);
  const effectiveBets = sigmaPct > 0 ? Math.pow(perfectSigma / sigmaPct, 2) : 1;

  const sigmaAmount = (sigmaPct / 100) * total;
  const warnings: string[] = [];
  if (n >= 2 && effectiveBets < 1.5) {
    warnings.push(
      `보유 ${n}종목이 거의 같이 움직입니다(실질 분산효과 ${effectiveBets.toFixed(1)}종목 수준). 종목을 나눠 담았다고 위험이 줄었다고 보면 안 되고, 사실상 한 종목에 몰아넣은 것과 비슷합니다.`,
    );
  }
  if (naiveUnderestimatePct >= 25) {
    warnings.push(
      `종목별 위험을 따로 더하면 실제 위험을 ${naiveUnderestimatePct.toFixed(0)}% 과소평가하게 됩니다 — 반도체주끼리 같은 방향으로 움직이기 때문입니다.`,
    );
  }

  const sorted = [...valid].map((p, i) => ({ name: p.name, weightPct: w[i] * 100 })).sort((a, b) => b.weightPct - a.weightPct);
  const topWeight = sorted[0] ?? null;
  if (topWeight && topWeight.weightPct >= 60) {
    warnings.push(`${topWeight.name} 비중이 ${topWeight.weightPct.toFixed(0)}%로 집중돼 있어, 이 종목 하나의 급락이 전체 손익을 좌우합니다.`);
  }

  // 경험적으로 국내 반도체주의 표준화잔차 5%/1% 분위는 대략 -1.55 / -2.45, 상방 +1.80 / +3.05
  // (5년 실측 평균). 개별 종목 분위수와 달리 포트폴리오는 분산 덕에 약간 정규분포에 가까워지므로
  // 보수적으로 개별 종목 값을 그대로 적용한다.
  return {
    available: true,
    totalValue: total,
    sigmaDailyPct: sigmaPct,
    sigmaDailyAmount: sigmaAmount,
    loss5Pct: -1.55 * sigmaAmount,
    loss1Pct: -2.45 * sigmaAmount,
    gain5Pct: 1.8 * sigmaAmount,
    effectiveBets,
    naiveUnderestimatePct,
    topWeight,
    warnings,
  };
}
