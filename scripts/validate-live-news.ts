// 실시간 뉴스·공시·일정표 회귀 테스트 — "트럼프 발언·중국 반도체·자사주가 제대로 잡히고, 엉뚱한 기사는 빠지는가"
//
// 실행: npx tsx scripts/validate-live-news.ts   (npm run validate:rules 에 포함)
import { buildNewsSet, classifyDisclosure, classifyHeadline, estimatePublishedAt, isRelevant } from "../lib/liveNews";
import { calendarCoverageEnd, scheduledEvents, upcomingEventNews } from "../lib/eventCalendar";
import type { NewsItem } from "../lib/types";

let fail = 0;
const ok = (c: boolean, m: string) => {
  if (!c) fail++;
  console.log(`${c ? "✅" : "❌"} ${m}`);
};
const mk = (o: Partial<NewsItem>): NewsItem => ({ title: "", summary: "", sentiment: "중립", impact: "중간", relatedTo: "반도체업황", ...o });

console.log("=== 제목 자동 분류 ===");
const cases: [string, NewsItem["sentiment"], NewsItem["impact"] | null][] = [
  ['트럼프 "반도체 관세 100% 부과하겠다"', "부정", "높음"],
  ["中 CXMT, 차세대 D램 연말 출시 예고", "부정", "높음"],
  ["China's CXMT Touts Next-Generation DRAM", "부정", "높음"],
  ["삼성전자, HBM4 엔비디아 품질 인증 통과", "긍정", null],
  ["SK하이닉스, 10조원 규모 자사주 매입 결정", "긍정", "높음"],
  ["美, 대중 반도체 수출통제 강화…엔비디아 H20도 금지", "부정", "높음"],
  ["Samsung and SK hynix shares sliding on CXMT fears", "부정", null],
];
for (const [t, s, i] of cases) {
  const c = classifyHeadline(t);
  ok(c.sentiment === s && (i == null || c.impact === i), `${t} → ${c.sentiment}/${c.impact}`);
}
ok(classifyHeadline("트럼프, 한국에 LNG 500억달러 투자 확약 요구").impact !== "높음", "트럼프 발언이라도 반도체·관세와 무관하면 '높음' 아님");
ok(classifyHeadline("SK하이닉스 HBM 공급 확대").stock === "SK하이닉스" && classifyHeadline("삼전닉스 동반 급락").stock === null, "종목 태깅 (삼전닉스는 둘 다)");

console.log("\n=== 공시 분류 ===");
const disc: [string, string, NewsItem["sentiment"]][] = [
  ["삼성전자(주) 자기주식 취득 결정", "자사주 매입 결정", "긍정"],
  ["에스케이하이닉스(주) 주식 소각 결정", "주식 소각 결정", "긍정"],
  ["에스케이하이닉스(주) 자기주식 처분 결정", "자사주 처분(임직원 보상 등)", "중립"],
  ["삼성전자(주) 연결재무제표기준영업(잠정)실적(공정공시)", "잠정 실적 발표", "중립"],
  ["XX(주) 유상증자 결정", "자금 조달(희석)", "부정"],
];
for (const [t, label, s] of disc) {
  const c = classifyDisclosure(t);
  ok(c.label === label && c.sentiment === s, `${t} → ${c.label}/${c.sentiment}`);
}

console.log("\n=== 관련성·시각 ===");
ok(!isRelevant(mk({ title: "상장사 자사주 소각 62조원 역대급… KB금융·셀트리온 등", relatedTo: "자사주" })), "다른 회사 자사주 기사는 제외");
ok(!isRelevant(mk({ title: "셀트리온, 기관 매수세 유입", relatedTo: "셀트리온" })), "예전 10종목 시절 기사 제외");
ok(isRelevant(mk({ title: "미국 9월 CPI 발표 대기", relatedTo: "매크로" })), "매크로 기사는 유지");
ok(isRelevant(mk({ title: "한미반도체, HBM4용 TC 본더 공개", relatedTo: "한미반도체" })), "반도체 밸류체인 기사는 유지");
const seen = "2026-10-14T12:00:00.000Z";
ok(estimatePublishedAt(mk({ publishedAt: "3시간 전", seenAt: seen })) === "2026-10-14T09:00:00.000Z", "'3시간 전' → 처음 본 시각 - 3시간");
ok(estimatePublishedAt(mk({ publishedAt: "어제", seenAt: seen })) === "2026-10-13T12:00:00.000Z", "'어제' → 24시간 전");

const now = new Date("2026-10-14T13:00:00Z");
const set = buildNewsSet({
  now,
  snapshotSeenAt: seen,
  snapshot: [
    mk({ title: "오래된 기사", publishedAt: "14시간 전", seenAt: "2026-10-13T20:00:00.000Z", impact: "높음" }),
    mk({ title: "中 CXMT 4F² D램 출시 선언", publishedAt: "1시간 전", seenAt: seen, impact: "높음", sentiment: "부정", relatedTo: "중국반도체" }),
    mk({ title: "KB금융 자사주 소각", relatedTo: "자사주", publishedAt: "1시간 전", seenAt: seen }),
  ],
  live: [mk({ title: "中 CXMT, 4F² D램 출시 선언!", at: "2026-10-14T12:30:00.000Z", origin: "google", impact: "높음" })],
  events: upcomingEventNews(now),
});
ok(!set.some((n) => n.title === "오래된 기사"), "발행 24시간 지난 스냅샷 기사 제외 (처음 본 지 17시간 + 14시간 전)");
ok(set.filter((n) => /CXMT/.test(n.title)).length === 1, "같은 사안 중복 제거 (정리본 우선)");
ok(set.find((n) => /CXMT/.test(n.title))?.isBreaking === true, "발행 2시간·고영향 → 속보로 다시 계산");
ok(!set.some((n) => /KB금융/.test(n.title)), "무관 기사 제외");

console.log("\n=== 일정표 ===");
const ev = scheduledEvents();
const find = (title: RegExp, day: string) => ev.find((e) => title.test(e.title) && e.kst.startsWith(day));
ok(find(/CPI/, "2026-10-14")?.kst === "2026-10-14 21:30", "10/14 미국 CPI 08:30 ET(서머타임) → 21:30 KST");
ok(find(/CPI/, "2026-11-10")?.kst === "2026-11-10 22:30", "11/10 미국 CPI(서머타임 끝) → 22:30 KST");
ok(find(/FOMC/, "2026-10-29")?.kst === "2026-10-29 03:00", "10/28 FOMC 14:00 ET → 10/29 03:00 KST");
ok(find(/옵션 만기/, "2026-10-08") != null && find(/동시만기/, "2026-12-10") != null, "옵션만기 = 둘째 목요일, 12월은 동시만기");
const ups = upcomingEventNews(new Date("2026-10-14T03:00:00Z"));
const cpi = ups.find((n) => /CPI/.test(n.title));
ok(cpi?.eventAt === "오늘 21:30" && Math.abs((cpi?.eventInHours ?? 0) - 9.5) < 0.1, `낮 12시 기준 CPI까지 ${cpi?.eventInHours}시간 (${cpi?.eventAt})`);
const end = calendarCoverageEnd();
const daysLeft = (Date.parse(end) - Date.now()) / 86_400_000;
ok(daysLeft > 60, `일정표가 ${end}까지 있음 (${Math.round(daysLeft)}일 남음 — 60일 아래면 다음 해 일정을 추가할 것)`);

console.log(fail === 0 ? "\n전체 통과" : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
