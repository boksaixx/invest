// 비서 브리핑 문장 규칙 회귀 테스트 — 숫자를 지어내지 않는지, 위험이 먼저 오는지, 결론이 행 목록과 맞는지.
//
// 실행: npx tsx scripts/validate-briefing.ts
import { buildBriefing } from "../lib/briefing";
import { buildDoitRows } from "../lib/actions";
import type { DoitRow } from "../lib/actions";
import type { EngineSignal, Portfolio, Quote } from "../lib/types";

let fail = 0;
const ok = (c: boolean, m: string) => {
  if (!c) fail++;
  console.log(`${c ? "✅" : "❌"} ${m}`);
};
const kst = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+09:00`);
const q = (price: number, change: number): Quote => ({ symbol: "x", name: "x", price, prevClose: price - change, change, changePct: (change / (price - change)) * 100, currency: "KRW", time: new Date().toISOString() });
const sig = (over: Partial<EngineSignal>): EngineSignal =>
  ({
    ticker: "005930", name: "삼성전자", action: "보유", score: 55, confidence: "낮음", reasons: [], warnings: [], targetPrice: 270000, stopPrice: 245000,
    suggestedBudget: null, suggestedQty: null, pnlPct: 2, price: 255000, indicators: {} as never, intraday: null, marketPhase: { phase: "장중", kstTime: "10:00", note: "" },
    entryTriggers: [], invalidation: null, scaledEntry: [], scaledExit: [{ price: 260000, qty: 5, note: "" }], watchOrderNote: null, relativeStrengthNote: null,
    estimatedRoundTripCostWon: null, entryBlocked: false, breakEvenPrice: null, priceLimits: null, backtest: null, buyStrength: 3, sellStrength: 1,
    actionSummary: "", verdict: "", macroScore: 0, disclosures: [], suggestedEntryPrice: null, entryPriceBasis: null, investorFlow: [], volForecast: null,
    forecastPath: null, upRate: null, issueImpacts: [], riskOverlay: null, ...over,
  }) as EngineSignal;
const port: Portfolio = { cash: 5_000_000, cashUSD: 0, holdings: [{ ticker: "005930", qty: 10, avgPrice: 250000 }] };
const phase = { phase: "장중", kstTime: "10:00", note: "" };

console.log("=== 결과 없음 ===");
let b = buildBriefing({ now: kst("2026-09-07", "08:30"), phase: { phase: "장전", kstTime: "08:30", note: "" }, rows: [], result: null, quotes: null, macro: null, portfolio: port, totalAssetKrw: 7_550_000 });
ok(b.greeting === "좋은 아침이에요" && b.when.startsWith("장전 08:30 · 개장까지 30분"), `인사·시각: ${b.greeting} / ${b.when}`);
ok(!b.hasResult && /분석을 받으면/.test(b.headline), `결론: ${b.headline}`);
ok(b.lines.length === 0, "데이터 없으면 시장·계좌 문장을 지어내지 않음");
ok(b.alerts.some((a) => a.icon === "🌅"), "장전 안내 알림");

console.log("\n=== 보유 + 손절선 근접 + 하루손실 경고 ===");
const s1 = sig({ price: 246000, stopPrice: 245000, pnlPct: -1.6 });
const rows: DoitRow[] = buildDoitRows({ signals: [s1], advice: null, todayPlan: null }, port, { "005930": q(246000, -12000) });
b = buildBriefing({
  now: kst("2026-09-07", "10:00"), phase, rows,
  result: { generatedAt: kst("2026-09-07", "09:20").toISOString(), signals: [s1], news: [], dailyRisk: { available: true, todayPnlWon: -120000, todayPnlPct: -1.6, stopTriggered: false, warnTriggered: true } },
  quotes: { "005930": q(246000, -12000) }, macro: { kospi: q(6600, -100), sox: q(5000, -80) }, portfolio: port, totalAssetKrw: 7_460_000,
});
ok(b.lines[0].startsWith("코스피 -1.5%"), `시장 문장: ${b.lines[0]}`);
ok(b.lines.some((l) => /내 자산 746만원, 오늘 -12만원/.test(l)), `계좌 문장: ${b.lines.find((l) => l.includes("내 자산"))}`);
ok(b.alerts[0].level === "warn" && /손실이 커지고/.test(b.alerts[0].text), `첫 알림이 하루손실 경고: ${b.alerts[0].text}`);
ok(b.alerts.some((a) => /손절선까지 0\.4%/.test(a.text)), `손절선 근접 알림: ${b.alerts.find((a) => /손절선/.test(a.text))?.text}`);
ok(b.alerts.some((a) => a.icon === "🕒" && /40분/.test(a.text)), "장중 40분 지난 분석 알림");
ok(b.mood === "alert", `무드: ${b.mood}`);
ok(/보유 1종목은 손절선만/.test(b.headline), `결론: ${b.headline}`);

console.log("\n=== 손절선 이탈 → 위험 우선 ===");
const s2 = sig({ price: 244000, stopPrice: 245000, action: "손절", sellStrength: 10 });
const rows2 = buildDoitRows({ signals: [s2], advice: null, todayPlan: null }, port, { "005930": q(244000, -14000) });
b = buildBriefing({ now: kst("2026-09-07", "10:00"), phase, rows: rows2, result: { generatedAt: kst("2026-09-07", "09:55").toISOString(), signals: [s2], news: [] }, quotes: { "005930": q(244000, -14000) }, macro: null, portfolio: port, totalAssetKrw: 7_440_000 });
ok(rows2[0].kind === "sell" && rows2[0].verb === "지금 파세요", `행: ${rows2[0].verb}`);
ok(b.mood === "danger" && b.alerts[0].level === "danger", `무드 위험, 첫 알림 위험: ${b.alerts[0].text}`);
ok(/정리할 종목 1개/.test(b.headline), `결론: ${b.headline}`);

console.log("\n=== 예정 이벤트 + 속보 ===");
const s3 = sig({ issueImpacts: [{ topic: "관세", title: "트럼프, 반도체 관세 25% 발표", direction: "악재", strength: 3, why: "수출 단가 직결", isBreaking: true, flipped: false }] });
b = buildBriefing({
  now: kst("2026-09-07", "10:00"), phase, rows: buildDoitRows({ signals: [s3], advice: null, todayPlan: null }, port, null),
  result: { generatedAt: kst("2026-09-07", "09:58").toISOString(), signals: [s3], news: [{ title: "美 FOMC 금리 결정", summary: "", sentiment: "중립", impact: "높음", relatedTo: "예정이벤트", topic: "예정이벤트", eventAt: "내일 03:00", eventInHours: 17 }] },
  quotes: null, macro: null, portfolio: port, totalAssetKrw: 7_550_000,
});
ok(b.alerts.some((a) => a.icon === "⏰" && /FOMC/.test(a.text)), "예정 이벤트 알림");
ok(b.alerts.some((a) => a.icon === "📰" && /악재 속보/.test(a.text) && a.ticker === "005930"), "보유 종목 악재 속보 알림(종목 링크 포함)");

console.log("\n=== 미보유·결과 있음·할 일 없음 ===");
const empty: Portfolio = { cash: 20_000_000, cashUSD: 0, holdings: [] };
const s4 = sig({ action: "관망", pnlPct: null, score: 40, buyStrength: 0, sellStrength: null });
b = buildBriefing({ now: kst("2026-09-07", "20:00"), phase: { phase: "장마감", kstTime: "20:00", note: "" }, rows: buildDoitRows({ signals: [s4], advice: null, todayPlan: null }, empty, null), result: { generatedAt: kst("2026-09-07", "19:50").toISOString(), signals: [s4], news: [] }, quotes: null, macro: null, portfolio: empty, totalAssetKrw: 20_000_000 });
ok(/쉬는 것도 전략/.test(b.headline) && b.mood === "calm", `결론: ${b.headline} / ${b.mood}`);
ok(b.greeting === "오늘도 수고하셨어요" && /장 마감 20:00/.test(b.when), `${b.greeting} / ${b.when}`);

console.log(fail === 0 ? "\n전체 통과" : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
