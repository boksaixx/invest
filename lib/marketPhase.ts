// 한국 증권시장(KRX)·미국 증권시장(나스닥/NYSE) 정규장 시간대 판단 — 단타는 "언제"에 따라
// 전략이 달라지므로 지금이 어느 시간대인지를 신호에 명시적으로 반영한다.
import type { MarketPhaseInfo } from "./types";

// KRX 휴장일 — 연도별 확정 목록(음력 공휴일·대체공휴일·선거일·근로자의날 포함).
// 2026-09 감사에서 확인: 예전에는 양력 고정일만 있어 설날·추석 연휴에 "장중"으로 판정했고,
// 그 날 GitHub Actions가 15분마다 Gemini·Claude를 호출해 비용만 태웠다.
// 매년 12월 KRX 공지(다음 해 휴장일)를 보고 아래에 한 해를 추가할 것. 목록에 없는 연도는
// 양력 고정일(FIXED_HOLIDAYS_KST)로만 판정되므로 그 해 음력 연휴는 직접 확인해야 한다.
const KRX_HOLIDAYS_YMD = new Set([
  // 2026
  "2026-01-01", // 신정
  "2026-02-16", "2026-02-17", "2026-02-18", // 설날 연휴
  "2026-03-02", // 삼일절(일) 대체공휴일
  "2026-05-01", // 근로자의날 (KRX 휴장)
  "2026-05-05", // 어린이날
  "2026-05-25", // 부처님오신날(5/24 일) 대체공휴일
  "2026-06-03", // 제9회 전국동시지방선거
  "2026-08-17", // 광복절(8/15 토) 대체공휴일
  "2026-09-24", "2026-09-25", // 추석 연휴 (9/26 토는 대체 없음)
  "2026-10-05", // 개천절(10/3 토) 대체공휴일
  "2026-10-09", // 한글날
  "2026-12-25", // 성탄절
  "2026-12-31", // 연말 폐장
  // 2027
  "2027-01-01", // 신정
  "2027-02-08", "2027-02-09", // 설날(2/7 일) 연휴 + 대체공휴일
  "2027-03-01", // 삼일절
  "2027-05-05", // 어린이날
  "2027-05-13", // 부처님오신날
  "2027-08-16", // 광복절(8/15 일) 대체공휴일
  "2027-09-14", "2027-09-15", "2027-09-16", // 추석 연휴
  "2027-10-04", // 개천절(10/3 일) 대체공휴일
  "2027-10-11", // 한글날(10/9 토) 대체공휴일
  "2027-12-27", // 성탄절(12/25 토) 대체공휴일
  "2027-12-31", // 연말 폐장
]);

/** 이 날짜(KST, YYYY-MM-DD)의 연도가 위 목록에 들어 있는가 — 없으면 양력 고정일로만 판정한다는 뜻 */
function krxHolidayTableCovers(ymd: string): boolean {
  const year = ymd.slice(0, 4);
  for (const d of KRX_HOLIDAYS_YMD) if (d.startsWith(year)) return true;
  return false;
}

// 양력 고정 공휴일 — 연도별 표(KRX_HOLIDAYS_YMD)에 없는 연도의 폴백. 연말 KRX 폐장일(12/31)도 포함.
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
  const ymd = `${kst.getUTCFullYear()}-${monthDay}`;

  if (day === 0 || day === 6) {
    return { phase: "휴장(주말)", kstTime, note: "주말은 국내 증시가 열리지 않습니다. 다음 개장일 전략을 준비하세요." };
  }
  if (KRX_HOLIDAYS_YMD.has(ymd)) {
    return { phase: "휴장(공휴일)", kstTime, note: "KRX 휴장일(공휴일·대체공휴일·연말 폐장)입니다. 다음 개장일 전략을 준비하세요." };
  }
  if (!krxHolidayTableCovers(ymd) && FIXED_HOLIDAYS_KST.has(monthDay)) {
    return {
      phase: "휴장(공휴일)",
      kstTime,
      note: "양력 고정 공휴일로 국내 증시가 열리지 않습니다. (올해 휴장일 표가 아직 없어 설날·추석 등 음력 연휴는 직접 확인하세요.)",
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

// 미국 증시(NYSE/나스닥) 휴장일 — 연도별 확정 목록(관측일·요일 이동 공휴일 포함).
// 목록에 없는 연도는 아래 양력 고정일로만 판정한다.
const US_HOLIDAYS_MDY = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const FIXED_HOLIDAYS_US = new Set([
  "01-01", // New Year's Day
  "06-19", // Juneteenth
  "07-04", // Independence Day
  "12-25", // Christmas
]);

// 미국 동부시간(뉴욕) 기준 정규장 09:30~16:00 — Intl.DateTimeFormat의 America/New_York 타임존을
// 쓰면 서머타임(EDT/EST) 전환을 직접 계산할 필요 없이 자동으로 반영된다.
function getUSEasternParts(now: Date): { hh: number; mm: number; weekday: number; monthDay: string; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
    year: "numeric",
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
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function getUSMarketPhase(now: Date = new Date()): MarketPhaseInfo {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const kstTime = `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`;
  const { hh, mm, weekday, monthDay, ymd } = getUSEasternParts(now);
  const minutesOfDay = hh * 60 + mm;

  if (weekday === 0 || weekday === 6) {
    return { phase: "휴장(주말)", kstTime, note: "주말은 미국 증시가 열리지 않습니다. 다음 개장일 전략을 준비하세요." };
  }
  if (US_HOLIDAYS_MDY.has(ymd)) {
    return { phase: "휴장(공휴일)", kstTime, note: "미국 증시 휴장일입니다. 다음 개장일 전략을 준비하세요." };
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

/**
 * 가상자산(업비트) — 24시간 거래. "장"은 닫히지 않지만 업비트 일봉이 09:00 KST에 시작하므로
 * 엔진의 오프닝레인지·VWAP·"당일" 기준도 09:00을 세션 시작으로 본다. 09:00~09:30은 국내 주식과
 * 같은 이유로(방향이 자주 뒤집힘) 장초반으로 두고, 그 외는 전부 장중이다. 마감임박·동시호가는 없다
 * (당일 청산 규칙 ③은 자연히 적용되지 않는다 — 넘길 밤이 따로 없기 때문).
 */
export function getCryptoMarketPhase(now: Date = new Date()): MarketPhaseInfo {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const hh = kst.getUTCHours();
  const mm = kst.getUTCMinutes();
  const kstTime = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const minutesOfDay = hh * 60 + mm;
  if (minutesOfDay >= 9 * 60 && minutesOfDay < 9 * 60 + 30) {
    return { phase: "장초반", kstTime, note: "업비트 일봉이 09:00에 새로 시작됐습니다. 첫 30분은 방향이 자주 뒤집히니 VWAP 위 안착 후 진입하세요." };
  }
  const usSession = minutesOfDay >= 22 * 60 + 30 || minutesOfDay < 5 * 60;
  return {
    phase: "장중",
    kstTime,
    note: usSession
      ? "미국 정규장 시간대(한국시간 22:30~05:00)입니다 — ETF 자금·나스닥과 같이 움직이는 시간이라 변동성이 커집니다."
      : "24시간 거래 중입니다. 손절 예약은 잠들기 전에 반드시 걸어두세요 — 밤사이 급변동은 예고 없이 옵니다.",
  };
}

export function getMarketPhaseForMarket(market: "KR" | "US" | "CRYPTO", now: Date = new Date()): MarketPhaseInfo {
  if (market === "CRYPTO") return getCryptoMarketPhase(now);
  return market === "US" ? getUSMarketPhase(now) : getMarketPhase(now);
}
