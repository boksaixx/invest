// 장중(인트라데이) 데이터 가공: VWAP, 갭, 오프닝레인지 브레이크아웃, 당일 모멘텀.
// 일봉 지표만으로는 "오늘 지금" 사야 할지 알 수 없다 — 단타 판단의 핵심은 이 파일이 계산한다.
import type { IntradayInsight } from "./types";
import type { RawIntradayCandle } from "./market";

function kstDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

// 09:00 KST(정규장 개장) 기준 경과 분
function kstMinutesSinceOpen(iso: string): number {
  const kst = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return (kst.getUTCHours() - 9) * 60 + kst.getUTCMinutes();
}

function emptyInsight(): IntradayInsight {
  return {
    available: false,
    sessionDate: "",
    isToday: false,
    todayOpen: 0,
    todayHigh: 0,
    todayLow: 0,
    current: 0,
    vwap: 0,
    distanceFromVwapPct: 0,
    gapPct: 0,
    gapType: "보합",
    rangePositionPct: 50,
    openingRangeHigh: null,
    openingRangeLow: null,
    orbStatus: "판단불가",
    momentum: "중립",
  };
}

export function computeIntradayInsight(
  rawCandles: RawIntradayCandle[],
  prevClose: number,
  currentPrice: number,
  now: Date = new Date(),
): IntradayInsight {
  if (rawCandles.length === 0) return emptyInsight();

  // 가장 최근 날짜(오늘 or 최근 거래일)의 캔들만 사용
  const lastDate = kstDateOf(rawCandles[rawCandles.length - 1].time);
  const todays = rawCandles.filter((c) => kstDateOf(c.time) === lastDate);
  if (todays.length === 0) return emptyInsight();

  const todayOpen = todays[0].open;
  const todayHigh = Math.max(...todays.map((c) => c.high), currentPrice);
  const todayLow = Math.min(...todays.map((c) => c.low), currentPrice);

  // VWAP = Σ(전형가격×거래량) / Σ거래량
  let cumPV = 0;
  let cumV = 0;
  for (const c of todays) {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
  }
  const vwap = cumV > 0 ? cumPV / cumV : todayOpen;

  const gapPct = prevClose ? ((todayOpen - prevClose) / prevClose) * 100 : 0;
  const gapType: IntradayInsight["gapType"] = gapPct > 0.3 ? "갭상승" : gapPct < -0.3 ? "갭하락" : "보합";

  const range = todayHigh - todayLow;
  const rangePositionPct = range > 0 ? Math.max(0, Math.min(100, ((currentPrice - todayLow) / range) * 100)) : 50;

  // 오프닝레인지: 개장(09:00 KST) 이후 첫 30분 캔들들의 고가/저가
  const orCandles = todays.filter((c) => {
    const m = kstMinutesSinceOpen(c.time);
    return m >= 0 && m < 30;
  });
  const openingRangeHigh = orCandles.length ? Math.max(...orCandles.map((c) => c.high)) : null;
  const openingRangeLow = orCandles.length ? Math.min(...orCandles.map((c) => c.low)) : null;

  let orbStatus: IntradayInsight["orbStatus"] = "판단불가";
  if (openingRangeHigh != null && openingRangeLow != null && todays.length > orCandles.length) {
    if (currentPrice > openingRangeHigh) orbStatus = "상단돌파";
    else if (currentPrice < openingRangeLow) orbStatus = "하단이탈";
    else orbStatus = "레인지내";
  }

  // 최근 최대 6개 캔들(약 30분)의 양봉/음봉 비율로 단기 모멘텀 판단
  const recent = todays.slice(-6);
  const netScore =
    recent.length > 0
      ? recent.reduce((a, c) => a + (c.close > c.open ? 1 : c.close < c.open ? -1 : 0), 0) / recent.length
      : 0;
  let momentum: IntradayInsight["momentum"] = "중립";
  if (netScore >= 0.6) momentum = "강한상승";
  else if (netScore >= 0.2) momentum = "상승";
  else if (netScore <= -0.6) momentum = "강한하락";
  else if (netScore <= -0.2) momentum = "하락";

  const todayKst = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

  return {
    available: true,
    sessionDate: lastDate,
    isToday: lastDate === todayKst,
    todayOpen,
    todayHigh,
    todayLow,
    current: currentPrice,
    vwap,
    distanceFromVwapPct: vwap ? ((currentPrice - vwap) / vwap) * 100 : 0,
    gapPct,
    gapType,
    rangePositionPct,
    openingRangeHigh,
    openingRangeLow,
    orbStatus,
    momentum,
  };
}
