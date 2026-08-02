// 안전 불변식 회귀 테스트 — 실제 돈이 걸린 숫자가 "이상하면 숨겨지는지" 검증한다.
//
// 실행: npx tsx scripts/validate-safety.ts
//
// 왜 있나: 외부 시세 API가 잘못된 현재가(0, null, 캔들과 자릿수가 다른 값)를 돌려주면
// ATR 기반 손절가가 음수로 계산돼 화면에 "손절 -35,062원"으로 떴다(QA에서 실제 재현).
// 사용자는 그 숫자를 그대로 증권사에 입력한다. 계산이 안 되면 값을 비우는 것이 정답이다.
//
// 검사 항목: 유한·양수 / 호가단위 / 현재가 대비 배율 / 손절<현재가<목표 / 수량이 현금 이내 /
//           점수·확률 범위 / 예상경로 상하단 역전 없음
import { readFileSync } from "node:fs";
import { runEngine } from "../lib/engine";
import { TICKER_LIST, STOCKS } from "../lib/types";
import type { Candle, MacroSnapshot, MarketPhaseInfo, Portfolio, EngineSignal } from "../lib/types";
import { tickSize } from "../lib/tick";

const h = JSON.parse(readFileSync("data/market-history.json", "utf8"));
const real = h.symbols["005930.KS"].candles as Candle[];
const macro0 = { usdkrw:null,kospi:null,nasdaq:null,sox:null,nikkei:null,shanghai:null,vix:null,spFutures:null,nasdaqFutures:null,fearGreed:null,oil:null,us10y:null } as MacroSnapshot;
const phase = { phase:"장중", kstTime:"10:00", note:"" } as MarketPhaseInfo;
const port: Portfolio = { cash: 20_000_000, cashUSD: 0, holdings: [] };

let fail = 0, warn = 0;
const bad = (m: string) => { fail++; console.log("❌ " + m); };
const wrn = (m: string) => { warn++; console.log("⚠️  " + m); };
const ok  = (m: string) => console.log("✅ " + m);

/** 어떤 신호든 반드시 성립해야 하는 불변식 */
function invariants(label: string, s: EngineSignal, price: number) {
  const cur = STOCKS[s.ticker].currency;
  const nums: [string, number | null | undefined][] = [
    ["stopPrice", s.stopPrice], ["targetPrice", s.targetPrice],
    ["suggestedEntryPrice", s.suggestedEntryPrice],
  ];
  for (const [k, v] of nums) {
    if (v == null) continue;
    if (!Number.isFinite(v)) return bad(`${label}: ${k}=${v} (유한수 아님)`);
    if (v <= 0) return bad(`${label}: ${k}=${v} (0 이하)`);
    if (cur === "KRW" && v % tickSize(v, "KRW") !== 0) return bad(`${label}: ${k}=${v} 호가 부적합`);
    if (v > price * 3 || v < price / 3) wrn(`${label}: ${k}=${v} 가 현재가 ${price}에서 3배 이상 벗어남`);
  }
  if (s.stopPrice != null && s.stopPrice >= price) wrn(`${label}: 손절가(${s.stopPrice}) >= 현재가(${price})`);
  if (s.targetPrice != null && s.targetPrice <= price) wrn(`${label}: 목표가(${s.targetPrice}) <= 현재가(${price})`);
  if (s.suggestedQty != null) {
    if (!Number.isInteger(s.suggestedQty)) return bad(`${label}: 수량 ${s.suggestedQty} 정수 아님`);
    if (s.suggestedQty < 0) return bad(`${label}: 수량 음수`);
    const cost = s.suggestedQty * (s.suggestedEntryPrice ?? price);
    if (cost > port.cash * 1.001) return bad(`${label}: 제안금액 ${Math.round(cost).toLocaleString()}원 > 현금 ${port.cash.toLocaleString()}원`);
  }
  if (s.score != null && (s.score < 0 || s.score > 100)) return bad(`${label}: score ${s.score} 범위 밖`);
  for (const f of ["buyStrength","sellStrength"] as const) {
    const v = (s as any)[f];
    if (v != null && (v < 0 || v > 10)) return bad(`${label}: ${f} ${v} 범위 밖`);
  }
  const fp = s.forecastPath;
  if (fp?.orderLevels) {
    const { buyProbPct, sellProbPct } = fp.orderLevels as any;
    for (const [k, v] of [["buyProbPct",buyProbPct],["sellProbPct",sellProbPct]] as [string,number][]) {
      if (v != null && (v < 0 || v > 100)) return bad(`${label}: ${k} ${v}% 범위 밖`);
    }
  }
  if (fp?.points) for (const p of fp.points as any[]) {
    if (p.lo > p.hi) return bad(`${label}: 예상경로 하단(${p.lo}) > 상단(${p.hi})`);
    if (p.lo <= 0) return bad(`${label}: 예상경로 하단 ${p.lo} <= 0`);
  }
  return ok(`${label}`);
}

const run = (o: Partial<Parameters<typeof runEngine>[0]>) =>
  runEngine({ ticker:"005930", price: real.at(-1)!.close, candles: real, macro: macro0, news: [],
    portfolio: port, intraday: null, marketPhase: phase, portfolioTotalAsset: 20_000_000, ...o } as any);

console.log("=== A. 캔들 부족 (신규 상장·데이터 유실) ===");
for (const n of [0, 1, 2, 5, 14, 20, 59, 60]) {
  try { const s = run({ candles: real.slice(-n) }); invariants(`캔들 ${n}개`, s, s.price); }
  catch (e) { bad(`캔들 ${n}개: 예외 ${String(e).slice(0,90)}`); }
}

console.log("\n=== B. 이상 가격 ===");
for (const p of [1, 0.5, 1e9]) {
  try { const s = run({ price: p }); invariants(`현재가 ${p}`, s, p); }
  catch (e) { bad(`현재가 ${p}: 예외 ${String(e).slice(0,90)}`); }
}
for (const p of [0, -1, NaN, Infinity]) {
  try { const s = run({ price: p });
    const anyBad = [s.stopPrice,s.targetPrice,s.suggestedEntryPrice].some(v=>v!=null&&!Number.isFinite(v));
    if (anyBad) bad(`현재가 ${p}: NaN/Infinity 가격이 그대로 출력됨`);
    else ok(`현재가 ${p}: 비정상 가격을 내지 않음`);
  } catch (e) { ok(`현재가 ${p}: 예외로 차단 (${String(e).slice(0,40)})`); }
}

console.log("\n=== C. 자산/현금 경계 ===");
for (const [cash, total, lbl] of [[0,20e6,"현금 0"],[1000,20e6,"현금 1천원"],[20e6,0,"총자산 0"],[20e6,-1,"총자산 음수"]] as [number,number,string][]) {
  try { const s = run({ portfolio: { ...port, cash }, portfolioTotalAsset: total });
    if (s.suggestedQty && s.suggestedQty * (s.suggestedEntryPrice ?? s.price) > cash * 1.001)
      bad(`${lbl}: 현금보다 큰 수량 ${s.suggestedQty}주 제안`);
    else ok(`${lbl}: 수량 ${s.suggestedQty ?? "없음"}`);
  } catch (e) { bad(`${lbl}: 예외 ${String(e).slice(0,90)}`); }
}

console.log("\n=== D. 상한가/하한가·무변동 ===");
const flat = real.slice(-120).map(c => ({ ...c, open:100000, high:100000, low:100000, close:100000 }));
try { const s = run({ candles: flat, price: 100000 }); invariants("완전 무변동(σ=0)", s, 100000); }
catch (e) { bad(`무변동: 예외 ${String(e).slice(0,90)}`); }
const limitUp = [...real.slice(-120)];
limitUp[limitUp.length-1] = { ...limitUp.at(-1)!, close: limitUp.at(-2)!.close*1.30, high: limitUp.at(-2)!.close*1.30, low: limitUp.at(-2)!.close*1.30 };
try { const s = run({ candles: limitUp, price: limitUp.at(-1)!.close }); invariants("상한가(+30%)", s, limitUp.at(-1)!.close); }
catch (e) { bad(`상한가: 예외 ${String(e).slice(0,90)}`); }

console.log("\n=== E. 전 종목 × 극단 매크로 ===");
const crash = { ...macro0, sox:{price:100,changePct:-12,time:""}, kospi:{price:2000,changePct:-9,time:""}, vix:{price:80,changePct:120,time:""}, usdkrw:{price:1600,changePct:8,time:""} } as any;
for (const t of TICKER_LIST) {
  const donor = h.symbols[["005930.KS","000660.KS","042700.KS","009150.KS","000990.KS"][TICKER_LIST.indexOf(t)%5]].candles as Candle[];
  try { const s = runEngine({ ticker:t, price:donor.at(-1)!.close, candles:donor, macro:crash, news:[],
      portfolio:port, intraday:null, marketPhase:phase, portfolioTotalAsset:20_000_000 } as any);
    invariants(`${STOCKS[t].name} 폭락장`, s, donor.at(-1)!.close);
  } catch (e) { bad(`${STOCKS[t].name}: 예외 ${String(e).slice(0,90)}`); }
}

console.log(`\n${fail===0?"통과":"실패 "+fail+"건"} / 경고 ${warn}건`);
process.exit(fail === 0 ? 0 : 1);
