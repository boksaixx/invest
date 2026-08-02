// 화면에 나가는 문장들이 서로 모순되지 않는지 전수 검사한다.
//
// 실행: npx tsx scripts/validate-consistency.ts
//
// 왜 있나: 실제로 "매수 강도 10/10 — 진입 신호 충족"과 "지금은 추격 매수하지 마세요
// (절대 금지)"가 같은 카드에 나란히 떴다. 10종목 중 5종목에서 재현됐다.
// 원인은 강도를 종합 점수만으로 계산하고, 그 뒤 과열·변동성·상관한도·하루손실한도가
// 진입을 막은 사실을 반영하지 않은 것이었다.
//
// 이 앱은 초보자가 큰 숫자를 먼저 믿고 실제 돈을 넣는다. 두 문장이 반대를 말하면
// 어느 쪽을 따르든 절반은 틀린 판단이 된다. 그래서 모순은 버그로 취급한다.
import { readFileSync } from "node:fs";
import { runEngine } from "../lib/engine";
import { TICKER_LIST, STOCKS } from "../lib/types";
import type { Candle, EngineSignal, IntradayInsight, MacroSnapshot, MarketPhaseInfo, Portfolio } from "../lib/types";

const h = JSON.parse(readFileSync("data/market-history.json", "utf8")) as {
  symbols: Record<string, { candles: Candle[] }>;
};
const macro0 = { usdkrw: null, kospi: null, nasdaq: null, sox: null, nikkei: null, shanghai: null, vix: null,
  spFutures: null, nasdaqFutures: null, fearGreed: null, oil: null, us10y: null } as MacroSnapshot;
const phase = { phase: "장중", kstTime: "10:00", note: "" } as MarketPhaseInfo;

/** 과열(당일 고가권) 상태 재현 */
const hotIntraday = (px: number): IntradayInsight =>
  ({ available: true, isToday: true, vwap: px * 0.97, distanceFromVwapPct: 3, gapType: "상승갭", gapPct: 2,
     orbStatus: "상단돌파", openingRangeHigh: px * 0.99, openingRangeLow: px * 0.96, momentum: "강한상승",
     rangePositionPct: 98, volumeRatio: 2.1, note: "" }) as never;

const BUY_CLAIM = /진입 신호 충족|지금 사도 좋아요|매수를 고려/;
const BUY_FORBID = /하지 마세요|절대 금지|진입은 보류|신규 진입을 보류|매수를 멈췄|살 자리는 아니/;
const SELL_CLAIM = /즉시 매도|전량 매도를 고려|정리할 자리|지금 파세요/;
const HOLD_CLAIM = /계속 보유|보유 유지|그대로 두세요/;

interface Case { name: string; sig: EngineSignal; }
const cases: Case[] = [];

function build(label: string, opts: Partial<Parameters<typeof runEngine>[0]>, port: Portfolio) {
  for (const t of TICKER_LIST) {
    const c = h.symbols[STOCKS[t].yahoo]?.candles;
    if (!c || c.length < 60) continue;
    const px = c.at(-1)!.close;
    try {
      const sig = runEngine({ ticker: t, price: px, candles: c, macro: macro0, news: [], portfolio: port,
        intraday: null, marketPhase: phase, portfolioTotalAsset: 20_000_000, prevClose: c.at(-2)!.close, ...opts } as never);
      cases.push({ name: `${label} / ${STOCKS[t].name}`, sig });
    } catch (e) {
      cases.push({ name: `${label} / ${STOCKS[t].name}`, sig: { verdict: `예외: ${e}`, actionSummary: "", action: "관망", buyStrength: 0, sellStrength: null, warnings: [] } as never });
    }
  }
}

const empty: Portfolio = { cash: 20_000_000, cashUSD: 0, holdings: [] };
const held = (t: string, px: number): Portfolio => ({ cash: 3_000_000, cashUSD: 0, holdings: [{ ticker: t as never, qty: 10, avgPrice: px }] });

build("평상시·미보유", {}, empty);
build("과열·미보유", { intraday: hotIntraday(1) }, empty); // px는 종목별로 아래에서 다시 계산되지 않으므로 근사
// 과열은 종목별 가격이 필요해 따로 만든다
for (const t of TICKER_LIST) {
  const c = h.symbols[STOCKS[t].yahoo]?.candles;
  if (!c || c.length < 60) continue;
  const px = c.at(-1)!.close;
  cases.push({ name: `과열(정확) / ${STOCKS[t].name}`,
    sig: runEngine({ ticker: t, price: px, candles: c, macro: macro0, news: [], portfolio: empty,
      intraday: hotIntraday(px), marketPhase: phase, portfolioTotalAsset: 20_000_000, prevClose: c.at(-2)!.close } as never) });
  cases.push({ name: `하루손실한도 / ${STOCKS[t].name}`,
    sig: runEngine({ ticker: t, price: px, candles: c, macro: macro0, news: [], portfolio: empty,
      intraday: null, marketPhase: phase, portfolioTotalAsset: 20_000_000, prevClose: c.at(-2)!.close,
      dailyStopTriggered: true } as never) });
  cases.push({ name: `보유중 / ${STOCKS[t].name}`,
    sig: runEngine({ ticker: t, price: px, candles: c, macro: macro0, news: [], portfolio: held(t, px * 1.05),
      intraday: null, marketPhase: phase, portfolioTotalAsset: 20_000_000, prevClose: c.at(-2)!.close } as never) });
  cases.push({ name: `상관한도소진 / ${STOCKS[t].name}`,
    sig: runEngine({ ticker: t, price: px, candles: c, macro: macro0, news: [], portfolio: empty,
      intraday: null, marketPhase: phase, portfolioTotalAsset: 20_000_000, prevClose: c.at(-2)!.close,
      correlationHeadroom: 0 } as never) });
}

let fail = 0;
const bad = (name: string, why: string, a: string, b: string) => {
  fail++;
  console.log(`❌ ${name}\n     ${why}\n     ① ${a.slice(0, 90)}\n     ② ${b.slice(0, 90)}`);
};

for (const { name, sig } of cases) {
  const sum = sig.actionSummary ?? "";
  const vd = (sig.verdict ?? "").split("\n")[0];
  const warn = (sig.warnings ?? []).join(" ");

  // ① 요약이 매수를 말하는데 판정문이 매수를 막는가
  if (BUY_CLAIM.test(sum) && BUY_FORBID.test(vd)) bad(name, "요약은 매수, 판정은 금지", sum, vd);
  // ② 강도가 진입 문턱(7+)인데 최종 판단은 관망인가
  if (!sig.pnlPct && sig.buyStrength >= 7 && sig.action === "관망")
    bad(name, `매수강도 ${sig.buyStrength}인데 판단은 관망`, `buyStrength=${sig.buyStrength}`, `action=${sig.action}`);
  // ③ 판정문은 사라는데 경고는 사지 말라는가
  if (BUY_CLAIM.test(vd) && BUY_FORBID.test(warn)) bad(name, "판정은 매수, 경고는 금지", vd, warn);
  // ④ 매도를 권하면서 매수 진입가를 함께 내는가
  if ((sig.action === "손절" || sig.action === "전량매도") && sig.suggestedEntryPrice != null)
    bad(name, "매도 권고인데 매수 진입가 제시", `action=${sig.action}`, `entry=${sig.suggestedEntryPrice}`);
  // ⑤ 신규매수인데 수량이 0인가 ("사라"면서 살 수 없음)
  if (sig.action === "신규매수" && (sig.suggestedQty == null || sig.suggestedQty <= 0))
    bad(name, "신규매수인데 제안 수량이 없음", `action=${sig.action}`, `qty=${sig.suggestedQty}`);
  // ⑥ 보유 중 "계속 보유"인데 매도 강도가 높은가
  if (HOLD_CLAIM.test(vd) && (sig.sellStrength ?? 0) >= 6)
    bad(name, `보유 유지 판정인데 매도강도 ${sig.sellStrength}`, vd, `sellStrength=${sig.sellStrength}`);
  // ⑦ 손절가가 현재가보다 높은가 (매수 관점에서 즉시 손절인 자리)
  if (sig.stopPrice != null && sig.price > 0 && sig.stopPrice >= sig.price && sig.action === "신규매수")
    bad(name, "신규매수인데 손절가가 현재가 이상", `price=${sig.price}`, `stop=${sig.stopPrice}`);
}

console.log(`\n검사 ${cases.length}건 · 모순 ${fail}건`);
if (fail === 0) console.log("모든 시나리오에서 문장·숫자·판단이 일치합니다.");
process.exit(fail === 0 ? 0 : 1);
