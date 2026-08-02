// 실전 매매 규칙 회귀 테스트 — 하루 손실 한도 · 상하한가/VI · 매매일지 채점.
//
// 실행: npx tsx scripts/validate-trading-rules.ts
//
// 이 세 가지는 "분석"이 아니라 "실행"에 관한 규칙이다. 분석이 아무리 정확해도
// 하루에 계좌를 크게 태우거나, 체결되지 않을 가격에 주문을 걸거나,
// 추천이 맞았는지 확인하지 않으면 수익으로 이어지지 않는다.
import { computeDailyRisk, DAILY_STOP_PCT } from "../lib/dailyRisk";
import { computePriceLimits, checkOrderPrice } from "../lib/priceLimits";
import { recordAndScore, summarize } from "../lib/journal";
import type { Portfolio, Quote } from "../lib/types";
let fail=0; const ok=(c:boolean,m:string)=>{if(!c)fail++;console.log(`${c?"✅":"❌"} ${m}`)};

console.log("=== 하루 손실 한도 ===");
const q=(p:number,ch:number):Quote=>({symbol:"005930",name:"삼성전자",price:p,prevClose:p-ch,change:ch,changePct:ch/(p-ch)*100,currency:"KRW",time:new Date().toISOString()});
const pf=(qty:number):Portfolio=>({cash:3_000_000,cashUSD:0,holdings:[{ticker:"005930",qty,avgPrice:250000}]});
let r=computeDailyRisk(pf(26),{"005930":q(250000,-25000)},20_000_000);
ok(r.stopTriggered,`-25,000원×26주 = -65만원 / 2천만원 = ${r.todayPnlPct}% → 중단 발동`);
r=computeDailyRisk(pf(26),{"005930":q(250000,-10000)},20_000_000);
ok(!r.warnTriggered&&!r.stopTriggered,`-26만원 = ${r.todayPnlPct}% → 경고선(-1.5%) 미달이므로 조용히`);
r=computeDailyRisk(pf(26),{"005930":q(250000,-15000)},20_000_000);
ok(r.warnTriggered&&!r.stopTriggered,`-39만원 = ${r.todayPnlPct}% → 경고만 (중단은 아님)`);
r=computeDailyRisk(pf(26),{"005930":q(250000,5000)},20_000_000);
ok(!r.warnTriggered&&!r.stopTriggered,`+13만원 = +${r.todayPnlPct}% → 정상`);
ok(!computeDailyRisk({cash:2e7,cashUSD:0,holdings:[]},{},2e7).available,"보유 없으면 계산 안 함");
ok(!computeDailyRisk(pf(26),{},0).available,"총자산 0이면 계산 안 함");

console.log("\n=== 상하한가 · 정적VI ===");
const L=computePriceLimits(250000,262500);
ok(L.upperLimit===325000,`상한가 ${L.upperLimit.toLocaleString()} (전일 250,000 × 1.3)`);
ok(L.lowerLimit===175000,`하한가 ${L.lowerLimit.toLocaleString()}`);
ok(L.viUpper===275000&&L.viLower===225000,`VI ${L.viLower.toLocaleString()} ~ ${L.viUpper.toLocaleString()}`);
ok(L.beyondVi===null,"현재가 262,500은 VI 안쪽");
ok([L.upperLimit,L.lowerLimit,L.viUpper,L.viLower].every(v=>v%500===0),"전부 호가단위(500원) 배수");
ok(computePriceLimits(250000,280000).beyondVi==="상단","VI 상단 돌파 감지");
ok(!!checkOrderPrice(330000,L),"상한가 밖 지정가 경고: "+checkOrderPrice(330000,L)?.slice(0,40));
ok(checkOrderPrice(260000,L)===null,"정상 지정가는 경고 없음");
ok(!computePriceLimits(null,262500).available && !computePriceLimits(0,262500).available,"전일종가 없으면 생략");

console.log("\n=== 매매일지 채점 ===");
const now=new Date("2026-08-01T09:00:00Z");
let j=recordAndScore([],[
 {ticker:"005930" as never,name:"삼성전자",action:"신규매수",price:250000,entryPrice:250000,targetPrice:265000,stopPrice:240000},
 {ticker:"000660" as never,name:"SK하이닉스",action:"손절",price:1700000,entryPrice:null,targetPrice:null,stopPrice:1650000},
 {ticker:"042700" as never,name:"한미반도체",action:"관망",price:200000,entryPrice:null,targetPrice:null,stopPrice:null},
],{},now);
ok(j.length===2,`관망은 기록 안 함 (${j.length}건 기록)`);
j=recordAndScore(j,[],{"005930":270000,"000660":1600000},new Date("2026-08-04T09:00:00Z"));
const buy=j.find(e=>e.ticker==="005930")!, sell=j.find(e=>e.ticker==="000660")!;
ok(buy.outcome?.verdict==="목표달성"&&buy.outcome.signedPct===8,`매수추천 250,000→270,000 = ${buy.outcome?.verdict} +${buy.outcome?.signedPct}%`);
ok(sell.outcome?.verdict==="목표달성"&&sell.outcome.signedPct>0,`매도추천 1,700,000→1,600,000 = ${sell.outcome?.verdict} +${sell.outcome?.signedPct}% (내려서 정답)`);
const s=summarize(j);
ok(s.hitRatePct===100&&s.settled===2,`성적: ${s.headline}`);
ok(s.caution.includes("표본")&&s.caution.includes("성적표"),"표본 부족·해석 한계 경고 포함");
const dup=recordAndScore(j,[{ticker:"005930" as never,name:"삼성전자",action:"신규매수",price:250000,entryPrice:null,targetPrice:null,stopPrice:null}],{},new Date("2026-08-04T10:00:00Z"));
ok(dup.length===3,"같은 날 같은 방향 중복 시 1건만 (다른 날이므로 추가됨)");
console.log(fail===0?"\n전체 통과":`\n실패 ${fail}건`);
process.exit(fail===0?0:1);
