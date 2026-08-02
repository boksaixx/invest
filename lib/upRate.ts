// "오늘 오를 확률" — 앱이 이 질문에 답할 수 있는 유일하게 정직한 형태.
//
// 세 번 독립적으로 시도했고 세 번 다 같은 결론이 나왔다(scripts/validate-probability.ts,
// scripts/validate-analog.ts):
//   1) 유사 패턴 kNN(단일 시간대)     → 적중률 47.4% (기준선 54.2%에 미달)
//   2) 로지스틱 13개 다중 시간대 특징  → Brier 0.2506으로 기저율과 완전 동일, AUC 0.500
//      (3일·1주·2주·1개월·6개월·3년 수익률 + 변동성 국면 + 낙폭 + 이격 + RSI + 거래량
//       + 간밤 SOX + 전일 코스피를 전부 넣어도 정보가 늘지 않았다)
//   3) 국면 조건부 기저율(21개 국면)  → 다중검정 보정 후 유의미한 국면 0개
//
// 그래서 이 모듈은 "오늘 오를 확률 62%" 같은 숫자를 만들어내지 않는다. 대신
// "지금과 같은 국면에서 과거 N일 중 실제로 오른 비율"을 그대로 보여주고, 그 값이 전체
// 기저율과 통계적으로 구분되는지를 함께 표시한다. 대부분의 경우 답은 "구분되지 않는다"이며,
// 그 사실 자체가 가장 중요한 투자 정보다 — 방향에 베팅할 근거가 없다는 뜻이기 때문이다.
//
// 이 판단이 사용자에게 주는 실질적 결론:
//   "언제 사느냐(방향)"가 아니라 "얼마에·얼마나·어떤 조건에서 사느냐"가 수익을 가른다.
//   그래서 앱의 핵심 산출물은 지정가·체결확률·수량(리스크 1%)·손절선이다.
import probabilityStats from "../data/probability-stats.json";
import type { Candle } from "./types";

type RegimeRate = { regime: string; n: number; upRatePct: number; z: number; significant: boolean };
const RATES = (probabilityStats.regimeUpRates ?? []) as RegimeRate[];
const OVERALL_UP_PCT = probabilityStats.overallUpRatePct as number;
/** 다중검정 보정 후 기저율과 유의미하게 다른 국면 수 (0이면 어떤 국면도 방향을 못 가른다) */
export const SIGNIFICANT_REGIMES = probabilityStats.significantRegimes as number;

export interface UpRateView {
  available: boolean;
  regime: string; // 예: "고변동/조정/단기급락"
  upRatePct: number; // 과거 이 국면의 실제 상승 비율
  sampleN: number;
  overallPct: number; // 전체 기저 상승률
  /** 기저율과 통계적으로 구분되는가 (다중검정 보정 적용). false면 방향 판단 근거로 쓰면 안 된다 */
  distinguishable: boolean;
  headline: string; // 사용자에게 그대로 보여줄 한 문장
}

function sigma(c: Candle[], t: number, win: number): number {
  const rs: number[] = [];
  for (let i = Math.max(1, t - win + 1); i <= t; i++) {
    if (c[i - 1].close > 0 && c[i].close > 0) rs.push(Math.log(c[i].close / c[i - 1].close));
  }
  return rs.length < 5 ? NaN : Math.sqrt(rs.reduce((a, b) => a + b * b, 0) / rs.length);
}

/**
 * 현재 국면을 분류한다. 검증 스크립트(validate-probability.ts)의 bucketFull과 반드시 같은
 * 기준이어야 한다 — 다르면 엉뚱한 국면의 통계를 갖다 붙이게 된다.
 */
export function classifyRegime(candles: Candle[]): string | null {
  const t = candles.length - 1;
  if (t < 260 || !(candles[t].close > 0)) return null;
  const sd60 = sigma(candles, t, 60);
  const sd250 = sigma(candles, t, 250);
  const sd20 = sigma(candles, t, 20);
  if (!(sd60 > 0) || !(sd250 > 0)) return null;

  const volRatio = sd20 / sd250 - 1;
  const high60 = Math.max(...candles.slice(t - 59, t + 1).map((x) => x.close));
  const drawdown = (candles[t].close / high60 - 1) / 0.12;
  const p5 = candles[t - 5]?.close;
  const ret1w = p5 > 0 ? Math.log(candles[t].close / p5) / (sd60 * Math.sqrt(5)) : 0;

  const vr = volRatio > 0.3 ? "고변동" : volRatio < -0.2 ? "저변동" : "보통";
  const dd = drawdown < -1.5 ? "붕괴" : drawdown < -0.5 ? "조정" : "고점권";
  const mo = ret1w > 0.5 ? "단기급등" : ret1w < -0.5 ? "단기급락" : "횡보";
  return `${vr}/${dd}/${mo}`;
}

/** 국면 분류 → 실측 상승률 조회. 표본이 부족하거나 국면을 못 정하면 available=false. */
export function computeUpRate(candles: Candle[]): UpRateView {
  const empty: UpRateView = {
    available: false,
    regime: "",
    upRatePct: NaN,
    sampleN: 0,
    overallPct: OVERALL_UP_PCT,
    distinguishable: false,
    headline: "",
  };
  const regime = classifyRegime(candles);
  if (!regime) return empty;
  const hit = RATES.find((r) => r.regime === regime);
  if (!hit) {
    return {
      ...empty,
      regime,
      headline: `지금은 "${regime}" 국면입니다. 과거 같은 국면 표본이 80일 미만이라 상승 비율을 제시하지 않습니다.`,
    };
  }

  const headline = hit.significant
    ? `지금은 "${regime}" 국면입니다. 과거 같은 국면 ${hit.n}일 중 ${hit.upRatePct}%가 상승 마감했고, 이는 전체 평균 ${OVERALL_UP_PCT}%와 통계적으로 구분되는 드문 경우입니다.`
    : `지금은 "${regime}" 국면입니다. 과거 같은 국면 ${hit.n}일 중 ${hit.upRatePct}%가 상승 마감했지만, ` +
      `전체 평균 ${OVERALL_UP_PCT}%와 통계적으로 구분되지 않습니다 — 즉 오늘의 방향은 사실상 동전던지기입니다. ` +
      `방향에 베팅하지 말고 "얼마에 사고, 얼마나 사고, 어디서 자를지"로 판단하세요.`;

  return {
    available: true,
    regime,
    upRatePct: hit.upRatePct,
    sampleN: hit.n,
    overallPct: OVERALL_UP_PCT,
    distinguishable: hit.significant,
    headline,
  };
}
