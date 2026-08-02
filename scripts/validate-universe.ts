// 유니버스 선정 근거 검증 — "무엇이 반도체와 분산이 안 되는가"를 실측한다.
//
// 실행: npx tsx scripts/validate-universe.ts
//
// 핵심 발견: 코스피 지수 자체가 반도체 5종목 블록과 상관 0.93이다(삼성전자·SK하이닉스가
// 지수를 지배). 그래서 국내 대형주를 추가해도 분산 효과는 제한적이며, 이 한계를 숨기지 않는다.
// 신규 5종목(방산·자동차·금융·바이오·통신)의 실제 상관은 히스토리가 쌓인 뒤 여기서 측정하고,
// 그 전까지는 앱의 computeCorrelationCap이 라이브 시세로 매 조회마다 직접 측정한다.
//
// 시차 보정: 국내 t일 vs 미국 t-1일(직전 미국장). 이 프로젝트가 이미 SOX에서 확인한 관계.
import { readFileSync } from "node:fs";
import type { Candle } from "../lib/types";
const h=JSON.parse(readFileSync("data/market-history.json","utf8"));
const ret=(c:Candle[])=>{const m=new Map<string,number>();for(let i=1;i<c.length;i++)if(c[i-1].close>0&&c[i].close>0)m.set(c[i].date,Math.log(c[i].close/c[i-1].close));return m;};
const corr=(a:number[],b:number[])=>{const n=a.length,ma=a.reduce((x,y)=>x+y,0)/n,mb=b.reduce((x,y)=>x+y,0)/n;
 let s=0,da=0,db=0;for(let i=0;i<n;i++){const x=a[i]-ma,y=b[i]-mb;s+=x*y;da+=x*x;db+=y*y;}return s/Math.sqrt(da*db);};
const SEMI=["005930.KS","000660.KS","042700.KS","009150.KS","000990.KS"];
const semiRets=SEMI.map(s=>ret(h.symbols[s].candles));
const krDates=[...semiRets[0].keys()].filter(d=>semiRets.every(m=>m.has(d))).sort();
const block=new Map(krDates.map(d=>[d,semiRets.reduce((a,m)=>a+(m.get(d)??0),0)/5]));
const prevDay=(d:string)=>{const x=new Date(d);x.setDate(x.getDate()-1);return x.toISOString().slice(0,10);};

console.log("=== 시차 보정 상관: 국내 t일 vs 미국 t-1일(직전 미국장) ===");
console.log("(이 프로젝트가 SOX에서 확인한 대로, 미국→국내는 하룻밤 뒤 전이된다)\n");
console.log("종목".padEnd(14)+"동일날짜".padStart(10)+"시차보정".padStart(10)+"  최근6개월 시차보정  판정");
for(const [sym,name] of [["NVDA","엔비디아"],["GOOGL","구글"],["META","메타"],["TSLA","테슬라"],["^SOX","SOX지수"]] as [string,string][]){
  const r=ret(h.symbols[sym].candles as Candle[]);
  const rows=krDates.filter(d=>r.has(prevDay(d))||r.has(d));
  const same=rows.filter(d=>r.has(d));
  const lag=rows.filter(d=>r.has(prevDay(d)));
  const cSame=corr(same.map(d=>r.get(d)!),same.map(d=>block.get(d)!));
  const cLag=corr(lag.map(d=>r.get(prevDay(d))!),lag.map(d=>block.get(d)!));
  const l6=lag.slice(-122);
  const cLag6=corr(l6.map(d=>r.get(prevDay(d))!),l6.map(d=>block.get(d)!));
  const v=cLag6>=0.6?"❌ 사실상 같은 베팅":cLag6>=0.4?"△ 부분적 분산":cLag6>=0.25?"○ 분산 효과 있음":"◎ 뚜렷한 분산";
  console.log(name.padEnd(14)+cSame.toFixed(2).padStart(10)+cLag.toFixed(2).padStart(10)+cLag6.toFixed(2).padStart(18)+"  "+v);
}
console.log("\n=== 참고: 후보의 변동성·유동성 (단타 적합성) ===");
for(const [sym,name] of [["005930.KS","삼성전자(기준)"],["NVDA","엔비디아"],["GOOGL","구글"],["META","메타"],["TSLA","테슬라"]] as [string,string][]){
  const c=h.symbols[sym].candles as Candle[];
  const r=[...ret(c).values()].slice(-122);
  const sd=Math.sqrt(r.reduce((a,b)=>a+b*b,0)/r.length)*100;
  console.log(`  ${name.padEnd(14)} 최근6개월 일간 σ ${sd.toFixed(2)}%`);
}
