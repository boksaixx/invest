// 예상 주가 경로 — "지금 조회하면 마감까지, 그리고 내일·모레는 어떻게 될까"를 확률 구간으로 그린다.
//
// 왜 만들었나: 글로만 "예상 등락 -11.7% ~ +14.2%"라고 하면 감이 안 온다. 시간이 지날수록
// 불확실성이 어떻게 벌어지는지를 눈으로 보면 "지금 손절선이 너무 가깝다", "내일까지 보면
// 이만큼 벌어진다" 같은 판단이 바로 선다.
//
// 계산 방식 (모두 검증된 변동성 모델 위에 얹는다):
//  1. 하루 변동성(σ)은 lib/volatility.ts 의 검증된 추정치를 그대로 쓴다(90% 구간 적중률 88%).
//  2. 조회 시점부터 마감까지 남은 변동성은 σ × √(남은 분산 비율)로 줄인다. 분산은 시간에
//     비례해 쌓이므로 폭은 √시간에 비례한다(랜덤워크의 기본 성질).
//  3. 하루 중 변동이 균등하지 않다는 점을 반영한다 — 개장 직후와 마감 동시호가에 집중되는
//     U자 형태. 아래 INTRADAY_VAR_PROFILE 참고.
//  4. D+1, D+2는 하루치 분산을 순차로 더한다(√2, √3 배로 폭이 벌어짐).
//  5. 구간 폭은 정규분포가 아니라 종목별 경험분위수(꼬리가 두꺼움)를 쓴다.
//  6. 중앙선(median)은 기본이 "제자리"다. 다만 국면별 조건부 통계가 있으면 그 5일 중앙값을
//     하루치로 나눠 아주 약한 방향성만 반영한다 — 예측이 아니라 과거 같은 국면의 평균적 흐름이다.
//
// 정직한 한계:
//  - 랜덤워크 가정이라 "언제 어느 방향으로 튄다"는 예측이 아니다. 폭(불확실성 범위)의 추정이다.
//  - 장중 U자 프로파일은 자체 수집 로그 표본이 20건뿐이라 신뢰할 수 없어, 주식시장에서
//    일반적으로 관찰되는 표준 형태를 썼다. 종목별로 다를 수 있다.
//  - 갑작스러운 뉴스·공시는 어떤 통계 모델도 미리 알 수 없다.
import type { ForecastPathData, VolForecast } from "./types";
import { touchProbability } from "./touchProb";
import { roundToTick } from "./tick";

// 국내장 09:00~15:30 (390분) 동안의 분산 배분 — 개장 직후와 마감 무렵이 크고 점심때가 작은 U자.
// 각 원소는 30분 구간이 하루 전체 분산에서 차지하는 비율이며 합이 1이다.
// (자체 로그 표본이 부족해 실측 대신 통상적으로 관찰되는 형태를 사용 — 파일 상단 한계 참고)
const INTRADAY_VAR_PROFILE = [
  0.11, 0.09, 0.08, 0.07, 0.065, 0.06, // 09:00~12:00
  0.055, 0.055, 0.06, 0.07, 0.08, 0.10, // 12:00~15:00
  0.11, // 15:00~15:30 (마감 동시호가)
];
const SESSION_START_MIN = 9 * 60; // 09:00
const SESSION_END_MIN = 15 * 60 + 30; // 15:30
const BUCKET_MIN = 30;

export type PathPoint = ForecastPathData["points"][number];
export type ForecastPath = ForecastPathData;

/** 하루 중 fromMin~toMin 구간이 전체 일간 분산에서 차지하는 비율 (0~1). */
function varianceFraction(fromMin: number, toMin: number): number {
  const a = Math.max(SESSION_START_MIN, Math.min(fromMin, SESSION_END_MIN));
  const b = Math.max(SESSION_START_MIN, Math.min(toMin, SESSION_END_MIN));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = 0; i < INTRADAY_VAR_PROFILE.length; i++) {
    const bs = SESSION_START_MIN + i * BUCKET_MIN;
    const be = bs + BUCKET_MIN;
    const overlap = Math.max(0, Math.min(be, b) - Math.max(bs, a));
    if (overlap > 0) sum += INTRADAY_VAR_PROFILE[i] * (overlap / BUCKET_MIN);
  }
  return Math.min(1, sum);
}

/**
 * 예상 경로 생성.
 *
 * @param currentPrice 현재가
 * @param vf 검증된 변동성 추정 (lib/volatility.ts)
 * @param nowKstMinutes 현재 시각(KST) 자정 기준 분. 장 시작 전이면 09:00으로 취급됨
 * @param isKrMarket 국내장이면 true (미국장은 장중 프로파일이 달라 일 단위만 표시)
 * @param driftPerDayPct 하루당 방향성(%) — 국면별 조건부 통계에서 유도. 없으면 0
 * @param tradingDayNow 오늘이 거래일이면 true. 주말·공휴일에 "오후 3시반까지의 흐름"을 그리면
 *        열리지도 않는 장을 예측하는 셈이라, false면 장중 구간을 통째로 건너뛴다
 */
export function buildForecastPath(
  currentPrice: number,
  vf: VolForecast | null,
  nowKstMinutes: number,
  isKrMarket: boolean,
  driftPerDayPct = 0,
  tradingDayNow = true,
): ForecastPath {
  // 화면의 가격은 그대로 주문창에 옮겨 적는 값이므로 반드시 실제 호가에 맞춘다
  const cur: "KRW" | "USD" = isKrMarket ? "KRW" : "USD";
  const tick = (v: number, mode: "nearest" | "up" | "down" = "nearest") => roundToTick(v, cur, mode);
  const empty: ForecastPath = {
    available: false,
    currentPrice,
    asOfLabel: "",
    points: [],
    intradayRemainingPct: 0,
    note: "",
    orderLevels: null,
  };
  if (!vf?.available || !(currentPrice > 0)) return empty;

  const sigma = vf.sigmaDailyPct;
  const zq = vf.zQuantiles;
  const fmtHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  // 지정가 후보를 먼저 정한다 — 시간대별 확률이 이 "고정 가격"을 향해 올라가야 하기 때문.
  // 0.75σ를 쓰는 이유: 실측 도달률이 하단 33%·상단 40%로 "가끔 오는" 거리라 지정가로 걸어둘
  // 만하다. 더 가까우면 노이즈에 체결되고, 더 멀면 거의 오지 않는다.
  const ORDER_K = 0.75;
  // 기준 기간: 국내장 장중이면 오늘 마감까지 남은 변동성, 그 외에는 하루치
  const horizonVar =
    isKrMarket && tradingDayNow && nowKstMinutes < SESSION_END_MIN
      ? Math.max(0.05, varianceFraction(Math.max(SESSION_START_MIN, nowKstMinutes), SESSION_END_MIN))
      : 1;
  const orderMovePct = sigma * Math.sqrt(horizonVar) * ORDER_K;
  const buyLevel = tick(currentPrice * (1 - orderMovePct / 100));
  const sellLevel = tick(currentPrice * (1 + orderMovePct / 100));

  // 구간 폭을 "누적 분산 비율"에서 계산 — 폭은 √(분산비율)에 비례한다
  const pointAt = (label: string, varFraction: number, minutesAhead: number, isDayBoundary: boolean): PathPoint => {
    const scale = Math.sqrt(Math.max(0, varFraction));
    const drift = driftPerDayPct * varFraction; // 방향성은 시간에 비례(분산이 아니라)
    // 변동성이 극단으로 튀는 날에도 음수 가격이 나오지 않도록 바닥을 둔다(현재가의 1%).
    // 국내장은 ±30% 가격제한폭이 있어 현실에서 걸릴 일은 없지만, 차트가 깨지는 것보다는 낫다.
    const px = (zScaled: number) => Math.max(tick(currentPrice * 0.01), tick(currentPrice * (1 + (drift + zScaled * sigma * scale) / 100)));
    // 지정가 도달 확률은 "고정된 지정가까지 몇 σ 남았나"로 계산한다. 시간이 갈수록 scale이
    // 커져 같은 가격이 가까워지므로 확률이 올라간다 — "몇 시쯤 체결을 기대할 수 있나"를 읽는 값.
    const kTo = (target: number) => (scale > 0 ? Math.abs((target / currentPrice - 1) * 100) / (sigma * scale) : Infinity);
    return {
      label,
      minutesAhead,
      median: tick(currentPrice * (1 + drift / 100)),
      p25: px(zq.q25),
      p75: px(zq.q75),
      p05: px(zq.q05),
      p95: px(zq.q95),
      isDayBoundary,
      buyFillProbPct: Math.round(touchProbability(kTo(buyLevel), "down")),
      sellFillProbPct: Math.round(touchProbability(kTo(sellLevel), "up")),
    };
  };

  const points: PathPoint[] = [];
  let intradayRemaining = 0;
  let asOfLabel = "";

  // 날짜 구분은 "달력상 내일"이 아니라 "다음 거래일"이다 — 금요일 장중에 보면 D+1은 월요일이고,
  // 주말·공휴일에는 아예 장이 열리지 않는다. 라벨을 거래일 기준으로 써야 오해가 없다.
  const DAY_LABELS = ["다음 거래일", "2거래일 뒤", "3거래일 뒤"];

  if (isKrMarket && tradingDayNow && nowKstMinutes < SESSION_END_MIN) {
    // 장중(또는 장전) — 마감까지 남은 구간을 30분 단위로 그린다
    const start = Math.max(SESSION_START_MIN, nowKstMinutes);
    intradayRemaining = varianceFraction(start, SESSION_END_MIN);
    asOfLabel = nowKstMinutes < SESSION_START_MIN ? "장 시작 전" : `${fmtHm(start)} 기준`;
    // 다음 정각/30분부터 마감까지
    let t = Math.ceil((start + 1) / BUCKET_MIN) * BUCKET_MIN;
    while (t < SESSION_END_MIN) {
      points.push(pointAt(fmtHm(t), varianceFraction(start, t), t - start, false));
      t += BUCKET_MIN;
    }
    points.push(pointAt("15:30 마감", intradayRemaining, SESSION_END_MIN - start, true));
    // D+1, D+2 — 오늘 남은 분산 + 하루치씩 누적
    points.push(pointAt(DAY_LABELS[0], intradayRemaining + 1, SESSION_END_MIN - start + 390, true));
    points.push(pointAt(DAY_LABELS[1], intradayRemaining + 2, SESSION_END_MIN - start + 780, true));
  } else {
    // 장 마감 후 / 휴장일 / 미국 종목 — 남은 장중 구간이 없으므로 거래일 단위만
    asOfLabel = !tradingDayNow ? "휴장 중 · 직전 종가 기준" : isKrMarket ? "장 마감 기준" : "현재 기준";
    DAY_LABELS.forEach((label, k) => points.push(pointAt(label, k + 1, (k + 1) * 390, true)));
  }

  const last = points[points.length - 1];
  const note =
    `색이 진한 안쪽 띠는 절반(50%) 확률 범위, 옅은 바깥 띠는 90% 확률 범위입니다. ` +
    `${last.label} 기준 90% 범위는 ${last.p05.toLocaleString()} ~ ${last.p95.toLocaleString()}입니다. ` +
    `방향을 맞히는 예측이 아니라 "이만큼은 움직일 수 있다"는 폭의 추정입니다.`;

  const anchor = points.find((p) => p.isDayBoundary) ?? last;
  const orderLevels =
    orderMovePct > 0
      ? {
          buyPrice: buyLevel,
          buyProbPct: Math.round(touchProbability(ORDER_K, "down")),
          sellPrice: sellLevel,
          sellProbPct: Math.round(touchProbability(ORDER_K, "up")),
          horizonLabel: anchor.label === "15:30 마감" ? "오늘 마감까지" : `${anchor.label}까지`,
        }
      : null;

  return {
    available: true,
    currentPrice,
    asOfLabel,
    points,
    intradayRemainingPct: intradayRemaining * 100,
    note,
    orderLevels,
  };
}

/** 국면별 조건부 통계(5일 중앙값)에서 하루당 방향성을 뽑는다. 과도한 외삽을 막기 위해 ±0.5%로 제한. */
export function driftFromScenario(d5Median: number | null | undefined): number {
  if (d5Median == null || !isFinite(d5Median)) return 0;
  const perDay = d5Median / 5;
  return Math.max(-0.5, Math.min(0.5, perDay));
}

/** KST 기준 현재 시각을 자정으로부터의 분으로. */
export function kstMinutesNow(now: Date = new Date()): number {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}
