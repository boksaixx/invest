// 한국 증권시장(KRX)·미국 증권시장(나스닥/NYSE) 정규장 시간대 판단 — 단타는 "언제"에 따라
// 전략이 달라지므로 지금이 어느 시간대인지를 신호에 명시적으로 반영한다.
import type { MarketPhaseInfo } from "./types";

// 양력 고정 공휴일만 반영 (매년 날짜가 바뀌는 설날·부처님오신날·추석 등 음력 공휴일은
// 자동 계산 오차 위험이 있어 이 버전에서는 제외했습니다 — 해당 주간에는 반드시
// 직접 개장 여부를 확인하세요). 연말 KRX 폐장일(12/31)도 포함.
const FIXED_HOLIDAYS_KST = new Set([
  "01-01", // 신정
  "03-01", // 삼일절
  "05-05", // 어린이날
  "06-06", // 현충일
  "08-15", // 광복절
  "10-03", // 개천절
  "10-09", // 한글날
  "12-25", // 크리스마스
  "12-31", // KRX 연말 폐장일
]);

export function getMarketPhase(now: Date = new Date()): MarketPhaseInfo {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const day = kst.getUTCDay(); // 0=일 ... 6=토 (KST 기준으로 이미 보정됨)
  const hh = kst.getUTCHours();
  const mm = kst.getUTCMinutes();
  const minutesOfDay = hh * 60 + mm;
  const kstTime = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const monthDay = `${String(kst.getUTCMonth() + 1).padStart(2, "0")}-${String(kst.getUTCDate()).padStart(2, "0")}`;

  if (day === 0 || day === 6) {
    return { phase: "휴장(주말)", kstTime, note: "주말은 국내 증시가 열리지 않습니다. 다음 개장일 전략을 준비하세요." };
  }
  if (FIXED_HOLIDAYS_KST.has(monthDay)) {
    return {
      phase: "휴장(공휴일)",
      kstTime,
      note: "양력 고정 공휴일로 국내 증시가 열리지 않습니다. (설날·추석 등 음력 공휴일은 이 목록에 없으니 해당 주간은 별도 확인하세요.)",
    };
  }
  if (minutesOfDay < 9 * 60) {
    return {
      phase: "장전",
      kstTime,
      note: "정규장 시작 전(09:00 개장)입니다. 간밤 미국 반도체지수·환율 흐름을 우선 확인하고, 개장 직후 갭 방향을 지켜보세요.",
    };
  }
  if (minutesOfDay < 9 * 60 + 30) {
    return {
      phase: "장초반",
      kstTime,
      note: "개장 후 30분(오프닝레인지 형성 구간)은 변동성이 가장 큽니다. 방향이 확정되기 전 추격 매수는 피하세요.",
    };
  }
  if (minutesOfDay < 11 * 60 + 30) {
    return { phase: "장중", kstTime, note: "정규 매매 시간대입니다. 오프닝레인지·VWAP 기준으로 판단하세요." };
  }
  if (minutesOfDay < 13 * 60) {
    return {
      phase: "점심시간대",
      kstTime,
      note: "거래량이 줄어드는 시간대(11:30~13:00)입니다. 신호 강도가 평소보다 약하게 나올 수 있으니 신규 진입은 신중히 하세요.",
    };
  }
  if (minutesOfDay < 14 * 60 + 30) {
    return { phase: "장중", kstTime, note: "정규 매매 시간대입니다." };
  }
  if (minutesOfDay < 15 * 60 + 20) {
    return {
      phase: "마감임박",
      kstTime,
      note: "마감 전 50분 구간입니다. 기관·외국인 수급이 급변할 수 있어 변동성이 커집니다. 보유 포지션의 당일 청산 여부를 결정하세요.",
    };
  }
  if (minutesOfDay < 15 * 60 + 30) {
    return { phase: "동시호가", kstTime, note: "장 마감 동시호가 시간대입니다. 신규 매매보다는 관망을 권장합니다." };
  }
  return { phase: "장마감", kstTime, note: "정규장이 마감되었습니다. 오늘 데이터를 복기하고 다음 거래일 전략을 준비하세요." };
}

// 미국 증시(나스닥/NYSE) 고정 공휴일 — 추수감사절처럼 매년 날짜가 바뀌는 공휴일은 한국 버전과
// 같은 이유로 제외 (해당 주간은 직접 개장 여부 확인 필요).
const FIXED_HOLIDAYS_US = new Set([
  "01-01", // New Year's Day
  "06-19", // Juneteenth
  "07-04", // Independence Day
  "12-25", // Christmas
]);

// 미국 동부시간(뉴욕) 기준 정규장 09:30~16:00 — Intl.DateTimeFormat의 America/New_York 타임존을
// 쓰면 서머타임(EDT/EST) 전환을 직접 계산할 필요 없이 자동으로 반영된다.
function getUSEasternParts(now: Date): { hh: number; mm: number; weekday: number; monthDay: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hh: Number(parts.hour) % 24,
    mm: Number(parts.minute),
    weekday: weekdayMap[parts.weekday] ?? 0,
    monthDay: `${parts.month}-${parts.day}`,
  };
}

export function getUSMarketPhase(now: Date = new Date()): MarketPhaseInfo {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const kstTime = `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`;
  const { hh, mm, weekday, monthDay } = getUSEasternParts(now);
  const minutesOfDay = hh * 60 + mm;

  if (weekday === 0 || weekday === 6) {
    return { phase: "휴장(주말)", kstTime, note: "주말은 미국 증시가 열리지 않습니다. 다음 개장일 전략을 준비하세요." };
  }
  if (FIXED_HOLIDAYS_US.has(monthDay)) {
    return {
      phase: "휴장(공휴일)",
      kstTime,
      note: "미국 고정 공휴일로 증시가 열리지 않습니다. (추수감사절 등 날짜가 매년 바뀌는 공휴일은 이 목록에 없으니 해당 주간은 별도 확인하세요.)",
    };
  }
  if (minutesOfDay < 9 * 60 + 30) {
    return {
      phase: "장전",
      kstTime,
      note: "미국 정규장 시작 전(현지시간 09:30 개장, 한국시간 기준 저녁~새벽)입니다. 프리마켓 흐름과 선물 방향을 우선 확인하세요.",
    };
  }
  if (minutesOfDay < 10 * 60) {
    return {
      phase: "장초반",
      kstTime,
      note: "개장 후 30분(오프닝레인지 형성 구간)은 변동성이 가장 큽니다. 방향이 확정되기 전 추격 매수는 피하세요.",
    };
  }
  if (minutesOfDay < 12 * 60) {
    return { phase: "장중", kstTime, note: "미국 정규 매매 시간대입니다. 오프닝레인지·VWAP 기준으로 판단하세요." };
  }
  if (minutesOfDay < 13 * 60) {
    return {
      phase: "점심시간대",
      kstTime,
      note: "미국 장중 거래량이 상대적으로 줄어드는 시간대(현지 12:00~13:00)입니다. 신호 강도가 평소보다 약하게 나올 수 있습니다.",
    };
  }
  if (minutesOfDay < 15 * 60 + 10) {
    return { phase: "장중", kstTime, note: "미국 정규 매매 시간대입니다." };
  }
  if (minutesOfDay < 15 * 60 + 50) {
    return {
      phase: "마감임박",
      kstTime,
      note: "마감 전 50분 구간입니다. 기관 수급(MOC 주문 등)이 급변할 수 있어 변동성이 커집니다. 보유 포지션의 당일 청산 여부를 결정하세요.",
    };
  }
  if (minutesOfDay < 16 * 60) {
    return { phase: "동시호가", kstTime, note: "장 마감 동시호가(MOC) 시간대입니다. 신규 매매보다는 관망을 권장합니다." };
  }
  return { phase: "장마감", kstTime, note: "미국 정규장이 마감되었습니다. 오늘 데이터를 복기하고 다음 거래일 전략을 준비하세요." };
}

export function getMarketPhaseForMarket(market: "KR" | "US", now: Date = new Date()): MarketPhaseInfo {
  return market === "US" ? getUSMarketPhase(now) : getMarketPhase(now);
}
