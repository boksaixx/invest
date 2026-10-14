// 예정 이벤트 달력 — "언제 큰 발표가 있나"를 뉴스 수집 결과에 기대지 않고 확정 일정으로 안다.
//
// 왜: 뉴스 수집(Gemini)이 예정 이벤트에 남은 시간(eventInHours)을 채워 줄 때만 "이벤트 전 수량 축소"가
//     작동했는데, 2026-10-14 점검 때 수집 뉴스 21건 중 예정 이벤트가 0건이었다(그날 밤 미국 CPI가 있었는데도).
//     그래서 날짜가 공식 발표된 일정은 여기 고정해 두고, 남은 시간은 매번 지금 시각으로 다시 계산한다.
//
// 출처(2026-10-14 확인): FOMC — federalreserve.gov 2026·2027 일정, 미국 CPI·고용·PPI — bls.gov 2026 일정,
//       한국은행 금통위 — 한국은행 2026 일정. 국내 옵션만기는 규칙(매월 둘째 목요일)으로 계산한다.
// 해마다 연말에 다음 해 일정을 추가해야 한다(없으면 그 해 이벤트가 조용히 빠진다 → scripts/validate-events.ts 가 경고).
import type { NewsItem } from "./types";

type Ev = { kst: string; title: string; impact: "높음" | "중간"; note?: string };

// 미국 동부시각(ET) 발표 → KST. 서머타임(2026: 3/8~11/1, 2027: 3/14~11/7)이면 +13시간, 아니면 +14시간
function etToKst(date: string, hhmm: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const dst =
    (y === 2026 && date >= "2026-03-08" && date < "2026-11-01") ||
    (y === 2027 && date >= "2027-03-14" && date < "2027-11-07");
  const utc = Date.UTC(y, m - 1, d, hh + (dst ? 4 : 5), mm);
  return new Date(utc + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

const FOMC_DECISION_DAYS = [
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
];
const US_CPI = ["2026-10-14", "2026-11-10", "2026-12-10", "2027-01-13", "2027-02-11", "2027-03-10", "2027-04-13", "2027-05-12", "2027-06-10", "2027-07-14", "2027-08-11", "2027-09-14", "2027-10-14", "2027-11-10", "2027-12-10"];
const US_JOBS = ["2026-10-02", "2026-11-06", "2026-12-04"];
const US_PPI = ["2026-10-15", "2026-11-13", "2026-12-15"];
const BOK = ["2026-10-22", "2026-11-26"];

function secondThursday(y: number, m: number): string {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=일
  const day = 1 + ((4 - first + 7) % 7) + 7;
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function scheduledEvents(): Ev[] {
  const out: Ev[] = [];
  for (const d of FOMC_DECISION_DAYS) out.push({ kst: etToKst(d, "14:00"), title: "미국 FOMC 금리 결정", impact: "높음", note: "연준 기준금리 발표·기자회견" });
  for (const d of US_CPI) out.push({ kst: etToKst(d, "08:30"), title: "미국 소비자물가(CPI) 발표", impact: "높음" });
  for (const d of US_JOBS) out.push({ kst: etToKst(d, "08:30"), title: "미국 고용보고서 발표", impact: "높음" });
  for (const d of US_PPI) out.push({ kst: etToKst(d, "08:30"), title: "미국 생산자물가(PPI) 발표", impact: "중간" });
  for (const d of BOK) out.push({ kst: `${d} 10:00`, title: "한국은행 기준금리 결정", impact: "높음" });
  for (let y = 2026; y <= 2027; y++) {
    for (let m = 1; m <= 12; m++) {
      const quad = m % 3 === 0;
      out.push({
        kst: `${secondThursday(y, m)} 15:20`,
        title: quad ? "국내 선물·옵션 동시만기(네 마녀의 날)" : "국내 옵션 만기일",
        impact: quad ? "높음" : "중간",
        note: "장 마감 동시호가에 프로그램 매매가 몰려 종가가 크게 흔들릴 수 있음",
      });
    }
  }
  return out.sort((a, b) => a.kst.localeCompare(b.kst));
}

const kstNowStr = (now: Date) => new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
const hoursUntil = (kst: string, now: Date) => (new Date(`${kst.replace(" ", "T")}:00+09:00`).getTime() - now.getTime()) / 3_600_000;

function whenLabel(kst: string, now: Date): string {
  const today = kstNowStr(now).slice(0, 10);
  const tomorrow = kstNowStr(new Date(now.getTime() + 86_400_000)).slice(0, 10);
  const day = kst.slice(0, 10);
  const hm = kst.slice(11, 16);
  if (day === today) return `오늘 ${hm}`;
  if (day === tomorrow) return `내일 ${hm}`;
  return `${Number(kst.slice(5, 7))}/${Number(kst.slice(8, 10))} ${hm}`;
}

/** 앞으로 horizonH시간 안의 예정 이벤트를 뉴스 형식(topic 예정이벤트)으로 — 남은 시간은 지금 기준 */
export function upcomingEventNews(now: Date = new Date(), horizonH = 72): NewsItem[] {
  return scheduledEvents()
    .map((e) => ({ e, h: hoursUntil(e.kst, now) }))
    .filter(({ h }) => h >= -1 && h <= horizonH)
    .map(({ e, h }) => ({
      title: e.title,
      summary: e.note ?? `${whenLabel(e.kst, now)} 발표 예정`,
      sentiment: "중립" as const,
      impact: e.impact,
      relatedTo: "예정이벤트",
      topic: "예정이벤트" as const,
      source: "일정표",
      eventAt: whenLabel(e.kst, now),
      eventInHours: Math.round(h * 10) / 10,
      eventAtKst: e.kst,
      isBreaking: false,
      seenAt: now.toISOString(),
    }));
}

/** 일정표가 앞으로 몇 달치 남았는지 — 비어 가면 회귀 테스트가 경고한다 */
export function calendarCoverageEnd(): string {
  const ev = scheduledEvents().filter((e) => !e.title.includes("옵션"));
  return ev[ev.length - 1]?.kst.slice(0, 10) ?? "";
}
