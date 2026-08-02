// "AI 정밀 분석" 버튼 한 번이 실제로 얼마인지, 모델을 바꾸면 얼마가 되는지 계산한다.
//
// 근거가 되는 실측값 두 가지:
//  (1) 입력 토큰 — buildAdvicePayload를 실제로 만들어 문자수로 센다(측정 스크립트와 동일 방식).
//  (2) 출력 토큰 — 상한 6,800에 걸려 응답이 8,202자에서 잘린 실제 사고가 있었다.
//      즉 바쁜 날의 출력은 최소 6,800 토큰이다. 이 값을 "많은 날"의 기준으로 쓴다.
//
// 단가는 2026-08-02 공식 가격표 기준(USD/100만 토큰).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAdvicePayload, SYSTEM_PROMPT_FOR_MEASURE } from "../lib/claude";
import type { CollectedSnapshot } from "../lib/types";

const CHARS_PER_TOKEN = 2.2; // 한국어 혼합 JSON 기준 경험값

const PRICE: Record<string, { in: number; out: number; label: string }> = {
  "claude-opus-4-8": { in: 5, out: 25, label: "Opus 4.8 (기존)" },
  "claude-sonnet-5": { in: 3, out: 15, label: "Sonnet 5 (신규 기본값)" },
  "claude-haiku-4-5": { in: 1, out: 5, label: "Haiku 4.5 (참고)" },
};

const snap = JSON.parse(
  readFileSync(join(process.cwd(), "data", "latest.json"), "utf8"),
) as CollectedSnapshot;

const events = JSON.parse(readFileSync(join(process.cwd(), "data", "events.json"), "utf8")) as {
  events: { date: string; title: string; note: string }[];
};

const payload = buildAdvicePayload({
  signals: snap.signals ?? [],
  macro: snap.macro,
  news: snap.news ?? [],
  portfolio: { cash: 20_000_000, cashUSD: 0, holdings: [] },
  events: events.events,
  krPhase: null,
  usPhase: null,
});

const tok = (s: string) => Math.round(s.length / CHARS_PER_TOKEN);
const perCallInput = tok(JSON.stringify(payload));
// SYSTEM + 이벤트 타임라인은 호출마다 동일해 프롬프트 캐시에 적중한다(1시간 TTL).
const cachedInput = tok(SYSTEM_PROMPT_FOR_MEASURE()) + tok(events.events.map((e) => `${e.date} ${e.title}: ${e.note}`).join("\n"));

// 출력 시나리오 — 실측 상한 도달(6,800)을 "많은 날", 그 60%를 "보통 날"로 둔다.
const OUT_BUSY = 6800;
const OUT_TYPICAL = Math.round(OUT_BUSY * 0.6);

function cost(model: string, outTok: number, cacheHit: boolean): number {
  const p = PRICE[model];
  const cacheCost = cacheHit ? cachedInput * p.in * 0.1 : cachedInput * p.in * 2; // 읽기 0.1배 / 쓰기(1h) 2배
  return (perCallInput * p.in + cacheCost + outTok * p.out) / 1_000_000;
}

console.log("=== AI 정밀 분석 1회 비용 (프롬프트 캐시 적중 기준) ===\n");
console.log(`  호출마다 새로 보내는 입력   ${perCallInput.toLocaleString()} 토큰`);
console.log(`  캐시되는 입력(SYSTEM+이벤트) ${cachedInput.toLocaleString()} 토큰`);
console.log(`  출력 — 보통 날 ${OUT_TYPICAL.toLocaleString()} / 많은 날 ${OUT_BUSY.toLocaleString()} 토큰 (실측 상한 도달값)\n`);

const KRW = 1400;
const rows: string[] = [];
for (const model of Object.keys(PRICE)) {
  const t = cost(model, OUT_TYPICAL, true);
  const b = cost(model, OUT_BUSY, true);
  rows.push(
    `  ${PRICE[model].label.padEnd(24)} 보통 ${(t * KRW).toFixed(0).padStart(4)}원   많은날 ${(b * KRW).toFixed(0).padStart(4)}원   ($${t.toFixed(4)} / $${b.toFixed(4)})`,
  );
}
console.log(rows.join("\n"));

const base = cost("claude-opus-4-8", OUT_TYPICAL, true);
const now = cost("claude-sonnet-5", OUT_TYPICAL, true);
console.log(`\n  Opus 4.8 → Sonnet 5 절감률: ${(((base - now) / base) * 100).toFixed(1)}%`);

console.log("\n=== 하루 사용량별 월 비용 (주 5일 × 21일, 환율 1,400원 가정) ===\n");
console.log("  하루 누르는 횟수   Opus 4.8(기존)      Sonnet 5(신규)      차액");
for (const perDay of [5, 10, 20, 40]) {
  const o = cost("claude-opus-4-8", OUT_TYPICAL, true) * perDay * 21 * KRW;
  const s = cost("claude-sonnet-5", OUT_TYPICAL, true) * perDay * 21 * KRW;
  console.log(
    `  ${String(perDay).padStart(2)}회${" ".repeat(14)}${Math.round(o).toLocaleString().padStart(9)}원${Math.round(s).toLocaleString().padStart(15)}원${("-" + Math.round(o - s).toLocaleString() + "원").padStart(14)}`,
  );
}

console.log("\n※ 자동수집(15분 간격 GitHub Actions)은 Haiku 4.5를 쓰며 월 5천원 안팎이라 이번 변경과 무관하다.");
console.log("※ 출력 토큰이 요금의 90% 이상을 차지한다 — 모델 단가와 응답 길이가 유일한 실질 레버다.");
