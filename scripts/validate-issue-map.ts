// 대외변수 → 종목별 방향 번역(lib/issueMap.ts)의 방향 불변식 회귀 테스트.
// 2026-10: 추적 종목이 삼성전자·SK하이닉스 2종목으로 줄어 다른 업종 사례는 뺐다.
//
// 실행: npx tsx scripts/validate-issue-map.ts
//
// 왜 있나: 예전 뉴스 점수는 "지정학"·"중국반도체"·"실적전망" 태그 기사를 어느 종목 점수에도 넣지
// 않았고(전쟁·관세가 0점), "중국반도체" 기사는 relatedTo에 "반도체"가 들어 KB금융까지 깎았으며,
// 전쟁 뉴스는 방산주에도 악재로 더해졌다. 민감도 표 자체는 실측이 아니라 설계값이므로
// "얼마나"는 검증할 수 없지만, "어느 방향으로, 어느 종목에" 는 반드시 성립해야 하는 불변식이다.
import { computeIssueImpacts, computeRiskOverlay, inferTopic, computeTopicBoard } from "../lib/issueMap";
import type { NewsItem } from "../lib/types";

let fail = 0;
const ok = (c: boolean, m: string) => {
  if (!c) fail++;
  console.log(`${c ? "✅" : "❌"} ${m}`);
};
const mk = (o: Partial<NewsItem>): NewsItem => ({
  title: "",
  summary: "",
  sentiment: "중립",
  impact: "높음",
  relatedTo: "매크로",
  ...o,
});

console.log("=== 방향 불변식 ===");
const war = mk({ title: "이란, 이스라엘 미사일 공격 — 중동 긴장 급고조", sentiment: "부정", relatedTo: "지정학", topic: "전쟁지정학", isBreaking: true });
let r = computeIssueImpacts([war], "005930");
ok(r.score < 0 && r.impacts[0]?.direction === "악재", `전쟁 긴장 → 삼성전자 ${r.score} 악재`);
const truce = mk({ title: "이란-이스라엘 휴전 합의 발표", sentiment: "긍정", relatedTo: "지정학", topic: "전쟁지정학" });

const china = mk({ title: "중국 CXMT, HBM3E 양산 진입 — 국내 메모리 판가 압박", sentiment: "부정", relatedTo: "중국반도체", topic: "중국" });
r = computeIssueImpacts([china], "000660");
ok(r.score < 0, `중국 반도체 경쟁 → SK하이닉스 ${r.score}`);

const byd = mk({ title: "BYD, 유럽 전기차 가격 20% 인하 — 가격 전쟁 격화", sentiment: "부정", relatedTo: "중국", topic: "중국" });
r = computeIssueImpacts([byd], "005930");
ok(r.score === 0, `BYD 가격 인하 → 삼성전자 ${r.score} (자동차 얘기라 미적용)`);
const tsmc = mk({ title: "TSMC, 2026년 매출 가이던스 40% 상향", sentiment: "긍정", relatedTo: "실적전망", topic: "실적" });

const tariff = mk({ title: "트럼프, 한국산 자동차 관세 25% 부과 발표", sentiment: "부정", relatedTo: "미국정책", topic: "관세", isBreaking: true });
const tariffAll = mk({ title: "트럼프, 한국에 상호관세 25% 발효 — 협상 결렬", sentiment: "부정", relatedTo: "미국정책", topic: "관세", isBreaking: true });
r = computeIssueImpacts([tariffAll], "005930");
ok(r.score < 0, `전 품목 상호관세 → 삼성전자 ${r.score}`);

const buyback = mk({ title: "KB금융, 5,000억원 자사주 매입·소각 결정", sentiment: "긍정", relatedTo: "KB금융", topic: "자사주", impact: "높음" });
r = computeIssueImpacts([buyback], "005930");
ok(r.score === 0, `KB금융 자사주 매입 → 삼성전자 ${r.score} (무관)`);

const fomc = mk({ title: "美 FOMC 금리 결정 발표 앞두고 관망세", sentiment: "중립", relatedTo: "예정이벤트", topic: "예정이벤트", eventAt: "내일 03:00", eventInHours: 14 });

const kt = mk({ title: "SKT 해킹 사태 여파 지속", sentiment: "부정", relatedTo: "매크로", topic: "기타" });

console.log("\n=== 범위·강도 ===");
const flood = Array.from({ length: 20 }, (_, i) => mk({ title: `악재 ${i}`, sentiment: "부정", relatedTo: "삼성전자", isBreaking: true }));
r = computeIssueImpacts(flood, "005930");
ok(r.score === -15, `악재 20건 속보라도 하한 -15 (${r.score})`);
ok(r.impacts.length <= 6, `영향 목록은 최대 6건 (${r.impacts.length})`);

console.log("\n=== 리스크 오버레이 ===");
// 기준 시각: 수요일 KST 08:00 (장 마감 15:30까지 7.5시간)
const AM8 = new Date("2026-10-14T08:00:00+09:00");
const bok = mk({ title: "한국은행 기준금리 결정", sentiment: "중립", relatedTo: "예정이벤트", topic: "예정이벤트", eventAt: "오늘 10:00", eventInHours: 2 });
let ov = computeRiskOverlay([bok], null, "005930", AM8);
ok(ov?.eventRisk === true && ov.sizeMultiplier === 0.7, `장중에 있는 고영향 이벤트(금통위 10:00) → 예산 ${ov?.sizeMultiplier}`);
ov = computeRiskOverlay([fomc], null, "005930", AM8);
ok(ov != null && ov.eventRisk === false && ov.sizeMultiplier === 1 && /장 마감 뒤/.test(ov.notes[0]), `장 마감 뒤 이벤트(FOMC 14시간 후) → 단타 수량은 그대로, 보유분 안내만`);
ov = computeRiskOverlay([fomc], null, "005930", new Date("2026-10-14T19:00:00+09:00"));
ok(ov?.eventRisk === true, "저녁 7시엔 FOMC(14시간 후)가 다음 장 마감 전이라 다음 날 단타 수량을 줄임");
ov = computeRiskOverlay([mk({ ...fomc, eventInHours: -0.3 })], null, "005930", new Date("2026-10-14T21:48:00+09:00"));
ok(ov === null || ov.eventRisk === false, "장 마감 뒤 막 발표된 미국 지표는 다음 날 단타 수량을 줄이지 않음");
ov = computeRiskOverlay([mk({ ...bok, eventInHours: -0.2 })], null, "005930", new Date("2026-10-14T10:12:00+09:00"));
ok(ov?.eventRisk === true && /발표 직후/.test(ov.notes[0]), "장중 막 발표된 금통위 → '발표 직후' 수량 축소");
ov = computeRiskOverlay([mk({ ...fomc, eventInHours: 60 })], null, "005930", AM8);
ok(ov === null, "60시간 뒤 이벤트는 아직 오버레이 없음");
ov = computeRiskOverlay([war], null, "005930");
ok(ov?.shockRisk === true && ov.sizeMultiplier === 0.7, `전쟁 고영향 악재 속보 → 쇼크 오버레이 예산 ${ov?.sizeMultiplier}`);
ov = computeRiskOverlay([{ ...war, isBreaking: false }], null, "005930");
ok(ov === null, "속보가 아니면(3시간 지남) 쇼크 오버레이 없음");
ov = computeRiskOverlay([war, bok], null, "005930", AM8);
ok(ov != null && ov.sizeMultiplier >= 0.5 && ov.notes.length === 2, `이벤트+쇼크 동시 → 예산 ${ov?.sizeMultiplier} (하한 0.5), 근거 2문장`);

console.log("\n=== 구버전 스냅샷(topic 없음) 추정 ===");
ok(inferTopic(mk({ title: "삼성전자, 3조원 규모 자사주 취득 결정", relatedTo: "삼성전자" })) === "자사주", "제목으로 자사주 추정");
ok(inferTopic(mk({ title: "국제유가 급등…중동 지정학 긴장 지속", relatedTo: "매크로" })) === "전쟁지정학", "제목으로 전쟁지정학 추정");
ok(inferTopic(mk({ title: "미국 8월 고용보고서 발표 앞두고 국채금리 변동성 주시", relatedTo: "매크로" })) === "예정이벤트", "'발표 앞두고' → 예정이벤트 추정");
ok(inferTopic(mk({ title: "중국 CXMT, HBM3E 소량 생산 진전", relatedTo: "중국반도체" })) === "중국", "relatedTo 중국반도체 → 중국");

console.log("\n=== 대외변수 보드 ===");
const board = computeTopicBoard([war, china, tariff, buyback, fomc]);
ok(board.topics.length === 4 && board.upcoming.length === 1, `축 ${board.topics.length}개, 예정 이벤트 ${board.upcoming.length}건`);
ok(board.topics.find((t) => t.topic === "전쟁지정학")?.pressure! < 0, "전쟁 축 압력 음수(코스피 기준)");

console.log(fail === 0 ? "\n전체 통과" : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
