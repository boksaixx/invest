// 대외변수 → 종목별 방향 번역(lib/issueMap.ts)의 방향 불변식 회귀 테스트.
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
let r = computeIssueImpacts([war], "012450");
ok(r.score > 0 && r.impacts[0]?.direction === "호재" && r.impacts[0]?.flipped, `전쟁 긴장(코스피 부정) → 한화에어로스페이스 +${r.score} 호재(반전)`);
r = computeIssueImpacts([war], "005930");
ok(r.score < 0 && r.impacts[0]?.direction === "악재", `전쟁 긴장 → 삼성전자 ${r.score} 악재`);
const truce = mk({ title: "이란-이스라엘 휴전 합의 발표", sentiment: "긍정", relatedTo: "지정학", topic: "전쟁지정학" });
r = computeIssueImpacts([truce], "012450");
ok(r.score < 0, `휴전(코스피 긍정) → 한화에어로스페이스 ${r.score} 악재(반전)`);

const china = mk({ title: "중국 CXMT, HBM3E 양산 진입 — 국내 메모리 판가 압박", sentiment: "부정", relatedTo: "중국반도체", topic: "중국" });
r = computeIssueImpacts([china], "000660");
ok(r.score < 0, `중국 반도체 경쟁 → SK하이닉스 ${r.score}`);
r = computeIssueImpacts([china], "105560");
ok(Math.abs(r.score) <= 1, `중국 반도체 경쟁 → KB금융 ${r.score} (거의 무관, 예전엔 -5)`);
r = computeIssueImpacts([china], "030200");
ok(r.score === 0, `중국 반도체 경쟁 → KT ${r.score} (무관)`);

r = computeIssueImpacts([china], "005380");
ok(r.score === 0, `중국 "HBM" 경쟁 → 현대차 ${r.score} (반도체 얘기라 자동차엔 미적용)`);
const byd = mk({ title: "BYD, 유럽 전기차 가격 20% 인하 — 가격 전쟁 격화", sentiment: "부정", relatedTo: "중국", topic: "중국" });
r = computeIssueImpacts([byd], "005380");
ok(r.score < 0, `BYD 가격 인하 → 현대차 ${r.score}`);
r = computeIssueImpacts([byd], "005930");
ok(r.score === 0, `BYD 가격 인하 → 삼성전자 ${r.score} (자동차 얘기라 미적용)`);
const tsmc = mk({ title: "TSMC, 2026년 매출 가이던스 40% 상향", sentiment: "긍정", relatedTo: "실적전망", topic: "실적" });
r = computeIssueImpacts([tsmc], "068270");
ok(r.score === 0, `TSMC 가이던스 → 셀트리온 ${r.score} (반도체 밸류체인이라 미적용)`);
r = computeIssueImpacts([tsmc], "042700");
ok(r.score > 0, `TSMC 가이던스 → 한미반도체 +${r.score}`);

const tariff = mk({ title: "트럼프, 한국산 자동차 관세 25% 부과 발표", sentiment: "부정", relatedTo: "미국정책", topic: "관세", isBreaking: true });
r = computeIssueImpacts([tariff], "005380");
ok(r.score <= -6, `자동차 관세 → 현대차 ${r.score} (가장 민감)`);
r = computeIssueImpacts([tariff], "012450");
ok(r.score === 0, `자동차 관세 → 한화에어로스페이스 ${r.score} (자동차 얘기라 미적용)`);
const tariffAll = mk({ title: "트럼프, 한국에 상호관세 25% 발효 — 협상 결렬", sentiment: "부정", relatedTo: "미국정책", topic: "관세", isBreaking: true });
r = computeIssueImpacts([tariffAll], "005930");
ok(r.score < 0, `전 품목 상호관세 → 삼성전자 ${r.score}`);
r = computeIssueImpacts([tariffAll], "105560");
ok(r.score < 0 && r.score > -3, `전 품목 상호관세 → KB금융 ${r.score} (간접·작게)`);

const buyback = mk({ title: "KB금융, 5,000억원 자사주 매입·소각 결정", sentiment: "긍정", relatedTo: "KB금융", topic: "자사주", impact: "높음" });
r = computeIssueImpacts([buyback], "105560");
ok(r.score >= 5 && /자사주/.test(r.impacts[0]?.why ?? ""), `KB금융 자사주 매입 → KB금융 +${r.score} (직접 재료)`);
r = computeIssueImpacts([buyback], "005930");
ok(r.score === 0, `KB금융 자사주 매입 → 삼성전자 ${r.score} (무관)`);

const fomc = mk({ title: "美 FOMC 금리 결정 발표 앞두고 관망세", sentiment: "중립", relatedTo: "예정이벤트", topic: "예정이벤트", eventAt: "내일 03:00", eventInHours: 14 });
r = computeIssueImpacts([fomc], "105560");
ok(r.score === 0, `예정 이벤트는 방향 점수에 안 들어감 (KB금융 ${r.score})`);

const kt = mk({ title: "SKT 해킹 사태 여파 지속", sentiment: "부정", relatedTo: "매크로", topic: "기타" });
r = computeIssueImpacts([kt], "030200");
ok(r.score === 0, `"SKT" 제목이 KT 직접 언급으로 오인되지 않음 (KT ${r.score})`);

console.log("\n=== 범위·강도 ===");
const flood = Array.from({ length: 20 }, (_, i) => mk({ title: `악재 ${i}`, sentiment: "부정", relatedTo: "삼성전자", isBreaking: true }));
r = computeIssueImpacts(flood, "005930");
ok(r.score === -15, `악재 20건 속보라도 하한 -15 (${r.score})`);
ok(r.impacts.length <= 6, `영향 목록은 최대 6건 (${r.impacts.length})`);

console.log("\n=== 리스크 오버레이 ===");
let ov = computeRiskOverlay([fomc], null, "005930");
ok(ov?.eventRisk === true && ov.sizeMultiplier === 0.7, `30시간 내 고영향 예정 이벤트 → 예산 ${ov?.sizeMultiplier}`);
ov = computeRiskOverlay([mk({ ...fomc, eventInHours: 60 })], null, "005930");
ok(ov === null, "60시간 뒤 이벤트는 아직 오버레이 없음");
ov = computeRiskOverlay([war], null, "005930");
ok(ov?.shockRisk === true && ov.sizeMultiplier === 0.7, `전쟁 고영향 악재 속보 → 쇼크 오버레이 예산 ${ov?.sizeMultiplier}`);
ov = computeRiskOverlay([war], null, "012450");
ok(ov?.shockRisk === true && /방산/.test(ov.notes[0]), "방산도 크기는 줄이되 '방향상 수혜' 문구 포함");
ov = computeRiskOverlay([{ ...war, isBreaking: false }], null, "005930");
ok(ov === null, "속보가 아니면(3시간 지남) 쇼크 오버레이 없음");
ov = computeRiskOverlay([war, fomc], null, "005930");
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
