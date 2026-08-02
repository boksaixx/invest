// 뉴스 파서 회귀 테스트 — "수집 60건"이 실제로 60건으로 남는지, 응답이 잘려도 살아남는지.
//
// 실행: npx tsx scripts/validate-news-parse.ts
//
// 이 테스트가 있는 이유: 수집 상한을 20→60건으로 올렸는데 파서 안에 slice(0,15)가 남아 있어
// 프롬프트만 바뀌고 실제 수집량은 그대로였던 적이 있다. 그리고 maxOutputTokens가 작아
// 응답이 중간에 잘리면 JSON.parse가 통째로 실패해 55건을 받아놓고 0건이 되기도 했다.
import { parseNewsJson } from "../lib/gemini";

const mk = (i: number) => ({
  title: `뉴스 제목 ${i} — 반도체 업황 관련 상세 헤드라인`,
  summary: `이것은 ${i}번째 기사의 한국어 요약문이며 숫자 ${i}%를 포함합니다.`,
  sentiment: "긍정",
  impact: "높음",
  relatedTo: "반도체업황",
  source: "연합뉴스",
  publishedAt: "2026-08-02 09:00:00",
  isBreaking: i % 10 === 0,
});

const full = JSON.stringify(Array.from({ length: 60 }, (_, i) => mk(i + 1)));
let fail = 0;
const check = (label: string, got: number, ok: boolean, note = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "✅" : "❌"} ${label} → ${got}건${note ? ` ${note}` : ""}`);
};

const a = parseNewsJson(`여기 결과입니다:\n${full}`);
check("정상 60건 응답", a.length, a.length === 60, "(예전 코드는 15건에서 잘렸다)");
check("속보 우선 정렬", a.length, a[0]?.isBreaking === true, a[0]?.isBreaking ? "" : "(속보가 맨 앞이 아님)");

// maxOutputTokens 초과로 마지막 객체를 쓰다 만 상태
const cut = `${full.slice(0, full.lastIndexOf("},") + 2)}{"title":"잘린 기사","summ`;
const b = parseNewsJson(cut);
check("잘린 응답 복구", b.length, b.length >= 55, "(전량 손실이면 실패)");

// 닫는 대괄호조차 없는 경우
const c = parseNewsJson(full.slice(0, 4000));
check("']' 없이 끊긴 응답 복구", c.length, c.length > 0);

// 완전히 JSON이 아닌 응답
const d = parseNewsJson("죄송합니다. 관련 뉴스를 찾지 못했습니다.");
check("JSON이 아닌 응답", d.length, d.length === 0, "(0건이어야 정상)");

// 상한 확인
const over = parseNewsJson(JSON.stringify(Array.from({ length: 120 }, (_, i) => mk(i + 1))));
check("120건 응답 (상한 80)", over.length, over.length === 80);

// 필수 필드 없는 항목은 버려야 한다
const dirty = parseNewsJson(JSON.stringify([{ title: "제목만 있음" }, mk(1)]));
check("불완전 항목 제외", dirty.length, dirty.length === 1);

console.log(fail === 0 ? "\n전체 통과" : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
