// 토큰 최적화가 정보를 잃지 않았는지 검증한다.
//
// 실행: npx tsx scripts/validate-payload.ts
//
// 토큰을 줄이는 방법은 두 가지다. (1) 중복·반복을 없애는 것, (2) 정보를 버리는 것.
// 이 앱은 실제 돈이 걸려 있어 (2)를 하면 안 된다. 그래서 최적화할 때마다
// "AI에게 가는 사실이 그대로인가"를 기계적으로 확인한다.
//
// 실제로 이 검사가 잡아낸 것: 압축 종목의 경고를 하나만 실어 두 번째 경고
// ("OBV 다이버전스", "20일선 아래")가 통째로 사라지고 있었다.
import { readFileSync } from "node:fs";
import { runEngine } from "../lib/engine";
import { buildAdvicePayload } from "../lib/claude";
import { TICKER_LIST, STOCKS } from "../lib/types";
import type { Candle, MacroSnapshot, MarketPhaseInfo, Portfolio } from "../lib/types";
const h=JSON.parse(readFileSync("data/market-history.json","utf8"));
const macro={usdkrw:null,kospi:null,nasdaq:null,sox:null,nikkei:null,shanghai:null,vix:null,spFutures:null,nasdaqFutures:null,fearGreed:null,oil:null,us10y:null} as MacroSnapshot;
const phase={phase:"장중",kstTime:"10:00",note:""} as MarketPhaseInfo;
const port:Portfolio={cash:3_000_000,cashUSD:0,holdings:[{ticker:"005930" as never,qty:26,avgPrice:250000}]};
const sigs=TICKER_LIST.map(t=>{
  const c=h.symbols[STOCKS[t].yahoo].candles as Candle[];
  return runEngine({ticker:t,price:c.at(-1)!.close,candles:c,macro,news:[],portfolio:port,intraday:null,
    marketPhase:phase,portfolioTotalAsset:20_000_000,prevClose:c.at(-2)!.close} as never);
});
const p:any=buildAdvicePayload({signals:sigs,macro,news:[],portfolio:port,events:[],relativeStrengthSummary:null,
  sectorConcentrationWarning:null,todayPlan:null,creditNote:null} as never);
const text=JSON.stringify(p);
let fail=0; const ok=(c:boolean,m:string)=>{if(!c)fail++;console.log(`${c?"✅":"❌"} ${m}`)};

// ① 모든 종목이 어떤 형태로든 페이로드에 존재하는가
const detailed=new Set((p["룰엔진_신호"]as any[]).map(r=>r.ticker));
const quietLines=(p["관망_종목_요약"]??[]) as string[];
for(const t of TICKER_LIST){
  const present=detailed.has(t)||quietLines.some(l=>l.startsWith(STOCKS[t].name));
  if(!present){fail++;console.log(`❌ ${STOCKS[t].name} 누락`);}
}
ok(detailed.size+quietLines.length===TICKER_LIST.length,`10종목 전부 전달 (상세 ${detailed.size} + 압축 ${quietLines.length})`);

// ② 모든 경고가 어딘가에 남아 있는가 (공통 최상위 / 종목별 / 압축줄)
const common=new Set((p["전종목_공통경고"]??[]) as string[]);
let lostW=0, keptW=0;
for(const s of sigs){
  for(const w of s.warnings.slice(0,3)){
    const inCommon=common.has(w);
    const row=(p["룰엔진_신호"]as any[]).find(r=>r.ticker===s.ticker);
    const inRow=row&&JSON.stringify(row).includes(w.slice(0,30));
    const inQuiet=quietLines.some(l=>l.includes(w.split(" — ")[0].slice(0,20)));
    if(inCommon||inRow||inQuiet) keptW++; else { lostW++; if(lostW<=3) console.log(`   (누락 경고) ${STOCKS[s.ticker].name}: ${w.slice(0,60)}`);}
  }
}
ok(lostW===0,`상위 경고 ${keptW}건 전부 전달 (누락 ${lostW}건)`);

// ③ 압축 종목도 판단에 필요한 값(가격·점수·변동성·경고)을 갖는가
for(const l of quietLines){
  const hasPrice=/[\d,]{4,}/.test(l), hasScore=/[+-]\d+p/.test(l), hasVol=/일간±/.test(l);
  if(!(hasPrice&&hasScore&&hasVol)){fail++;console.log(`❌ 압축줄 정보 부족: ${l}`);}
}
ok(quietLines.every(l=>/[\d,]{4,}/.test(l)&&/[+-]\d+p/.test(l)&&/일간±/.test(l)),
   `압축 ${quietLines.length}줄 모두 가격·점수·변동성 포함`);
quietLines.forEach(l=>console.log(`     ${l}`));

// ④ 공통 경고가 실제로 전 종목 것인가
for(const w of common) ok(sigs.every(s=>s.warnings.includes(w)), `공통경고가 실제 전 종목 공통: "${w.slice(0,40)}…"`);

// ⑤ 보유 종목은 반드시 상세
ok(detailed.has("005930"),"보유 종목(삼성전자)은 상세로 전달");
console.log(`\n${fail===0?"정보 손실 없음":`문제 ${fail}건`}`);
process.exit(fail===0?0:1);
