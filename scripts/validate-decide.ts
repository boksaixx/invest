// 화면 결론(lib/decide.ts) 회귀 테스트 — "언제 사라고 하고, 언제 말리는가"의 불변식.
//
// 실행: npx tsx scripts/validate-decide.ts   (npm run validate:rules 에 포함)
import { decide, DAY_BUY_PROB, hitRateOf } from "../lib/decide";
import type { Prediction } from "../lib/predict";
import type { EngineSignal, MarketPhaseInfo } from "../lib/types";
import model from "../data/model.json";

let fail = 0;
const ok = (c: boolean, m: string) => {
  if (!c) fail++;
  console.log(`${c ? "✅" : "❌"} ${m}`);
};

const sig = (o: Partial<EngineSignal> = {}): EngineSignal =>
  ({
    ticker: "005930", name: "삼성전자", action: "관망", score: 50, confidence: "낮음", reasons: [], warnings: [],
    targetPrice: 240000, stopPrice: 225000, suggestedBudget: null, suggestedQty: null, pnlPct: null, price: 232000,
    indicators: {} as EngineSignal["indicators"], intraday: null, marketPhase: { phase: "장중", kstTime: "10:10", note: "" },
    entryTriggers: [], invalidation: null, scaledEntry: [], scaledExit: [], watchOrderNote: null, relativeStrengthNote: null,
    estimatedRoundTripCostWon: null, entryBlocked: false, breakEvenPrice: null, priceLimits: null, backtest: null, buyStrength: 5,
    sellStrength: null, actionSummary: "", verdict: "", macroScore: 0, disclosures: [], suggestedEntryPrice: null, entryPriceBasis: null,
    investorFlow: [], volForecast: null, forecastPath: null, upRate: null, issueImpacts: [], riskOverlay: null,
    ...o,
  }) as EngineSignal;
const pred = (dayProb: number | null, checkpoint: Prediction["checkpoint"] = "h10"): Prediction => ({
  available: true, checkpoint, dayProb, swingProb: 0.5, dayCalib: null, swingCalib: null, dayEval: null, swingEval: null,
  dayReasons: [], swingReasons: [], features: {}, sigmaDailyPct: 3,
});
const ph = (phase: string, t = "10:10"): MarketPhaseInfo => ({ phase, kstTime: t, note: "" });
const base = { cash: 10_000_000, totalAsset: 10_000_000, correlationHeadroom: null, dailyStopTriggered: false, swingDays: 3 };

console.log("=== 미보유 ===");
let d = decide({ ...base, sig: sig(), pred: pred(0.6, "h10"), holding: null, phase: ph("장중") });
ok(d.verdict === "buy_now" && d.title === "지금 사세요", `오전 10시 확률 60% → ${d.title}`);
const qtyRow = d.plan.find((r) => r.label === "수량");
const qty = Number(qtyRow?.value.replace(/[^\d]/g, ""));
ok(qty > 0 && qty * (232000 - 225000) <= 10_000_000 * 0.01 + 1, `수량 ${qty}주 — 손절 시 손실 ${(qty * 7000).toLocaleString()}원 ≤ 총자산 1%`);
ok(qty * 232000 <= 10_000_000 * 0.25 + 1, "현금의 25% 이내");
d = decide({ ...base, sig: sig(), pred: pred(0.6, "h14"), holding: null, phase: ph("장중", "14:05") });
ok(d.verdict === "wait", `오후 2시 확률 60% → ${d.title} (오후 신호는 비용을 못 넘음)`);
d = decide({ ...base, sig: sig(), pred: pred(0.6, "pre"), holding: null, phase: ph("장전", "08:40") });
ok(d.verdict === "buy_open" && d.title === "9시에 사세요", `장전 확률 60% → ${d.title}`);
d = decide({ ...base, sig: sig(), pred: pred(0.4, "h11"), holding: null, phase: ph("장중", "11:00") });
ok(d.verdict === "wait" && d.timing != null && d.claim.dir === -1, `확률 40% → ${d.title} + 타이밍 안내, 성적표엔 '밀린다'로 기록`);
d = decide({ ...base, sig: sig(), pred: pred(0.5, "h11"), holding: null, phase: ph("장중", "11:00") });
ok(d.verdict === "wait" && d.claim.dir === 0, "확률 50% → 기다리세요, 방향 주장 없음");
d = decide({ ...base, sig: sig(), pred: pred(0.7, "h10"), holding: null, phase: ph("장중"), dailyStopTriggered: true });
ok(d.verdict === "wait", "하루 손실 한도 도달이면 확률이 높아도 사지 않음");
d = decide({ ...base, sig: sig({ warnings: ["오늘 상한가(+29.9%) 도달 — 더 이상 오늘은 오를 여력이 없습니다."] }), pred: pred(0.7, "h10"), holding: null, phase: ph("장중") });
ok(d.verdict === "wait", "상한가 날은 사지 않음");
d = decide({ ...base, cash: 100_000, totalAsset: 100_000, sig: sig(), pred: pred(0.7, "h10"), holding: null, phase: ph("장중") });
ok(d.verdict === "wait" && /현금/.test(d.summary), "현금이 1주 값보다 적으면 이유를 말하고 기다림");
d = decide({ ...base, sig: sig(), pred: pred(null, null), holding: null, phase: ph("장마감", "19:00") });
ok(d.verdict === "wait" && /장이 닫혀/.test(d.summary), "장 마감 후 → 장이 닫혀 있다고 안내");
d = decide({ ...base, sig: sig({ warnings: ["추격 보정 — 종합 점수는 매수 신호지만 VWAP 대비 +2.4% 이격"] , suggestedEntryPrice: 229000 }), pred: pred(0.6, "h10"), holding: null, phase: ph("장중") });
ok(d.title === "지정가로 사세요" && d.plan[0].value === "229,000원", "많이 오른 상태면 VWAP 지정가로 안내");

console.log("\n=== 보유 ===");
const held = { qty: 10, avgPrice: 240000 };
d = decide({ ...base, sig: sig({ action: "손절", pnlPct: -3.3 }), pred: pred(0.6, "h10"), holding: held, phase: ph("장중") });
ok(d.verdict === "stop_loss" && d.title === "지금 파세요", "손절 조건이면 확률과 무관하게 지금 파세요");
d = decide({ ...base, sig: sig({ action: "손절", pnlPct: -3.3 }), pred: pred(null, null), holding: held, phase: ph("장마감", "18:00") });
ok(d.title === "다음 장에 파세요", `장 마감 후 손절 → ${d.title}`);
d = decide({ ...base, sig: sig({ action: "부분매도", reasons: ["목표가 도달 — 절반 수익 실현"] }), pred: pred(0.5), holding: held, phase: ph("장중") });
ok(d.verdict === "sell_half" && d.plan[0].value.startsWith("5주"), "부분매도 → 절반(5주) 파세요");
d = decide({ ...base, sig: sig({ action: "보유" }), pred: pred(0.4, "h11"), holding: held, phase: ph("장중", "11:00") });
ok(d.verdict === "hold" && d.timing != null && /지금이 유리/.test(d.timing), "보유 + 확률 40% → 그대로 두되, 팔 거면 지금이 낫다고 안내");
d = decide({ ...base, sig: sig({ action: "보유" }), pred: pred(0.6, "h11"), holding: held, phase: ph("장중", "11:00") });
ok(d.verdict === "hold" && d.timing != null && /서두르지/.test(d.timing), "보유 + 확률 60% → 팔 거면 서두르지 말라고 안내");

console.log("\n=== 모델 성적표 ===");
const m = model as unknown as { day: Record<string, { eval: Parameters<typeof hitRateOf>[0] & { auc: number; byYear?: { auc: number }[] } }> };
for (const [k, v] of Object.entries(m.day)) {
  const h = hitRateOf(v.eval);
  ok(v.eval.auc > 0.52 && h != null && h.hitPct > h.naivePct, `${k}: 검증 AUC ${v.eval.auc}, 적중 ${h?.hitPct}% > 근거 없이 찍기 ${h?.naivePct}%`);
}
const yrs = m.day.open.eval.byYear ?? [];
ok(yrs.length >= 5 && yrs.every((y) => y.auc > 0.5), `개장 모델 해마다 기준선 위 (${yrs.map((y) => y.auc).join(", ")})`);
ok(DAY_BUY_PROB === 0.55, "매수 기준 확률 55%");

console.log(fail === 0 ? "\n전체 통과" : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
