// 일일 손실 한도(데일리 스톱)가 실제로 계좌를 지키는지 5개년 실데이터로 검증한다.
//
// 실행: npx tsx scripts/validate-daily-stop.ts
//
// 왜 필요한가: 이 앱에는 "1회 매매 리스크 = 총자산 1%"라는 건별 한도만 있고,
// 하루 전체를 멈추는 장치가 없다. 종목별로는 원칙을 지켜도 같은 날 여러 종목이
// 동시에 무너지면(반도체는 상관 0.89) 계좌 전체가 크게 빠진다.
// 여기서 두 가지를 실측한다.
//   ① 큰 손실이 난 날 "다음 날"은 어땠나 — 물타기·복수매매가 정당화되는가?
//   ② 데일리 스톱을 걸면 최악의 날과 최대낙폭이 실제로 줄어드는가?
import { readFileSync } from "node:fs";
import type { Candle } from "../lib/types";

const h = JSON.parse(readFileSync("data/market-history.json", "utf8")) as {
  symbols: Record<string, { candles: Candle[] }>;
};
const UNIV: [string, string][] = [
  ["005930.KS", "삼성전자"], ["000660.KS", "SK하이닉스"], ["042700.KS", "한미반도체"],
  ["009150.KS", "삼성전기"], ["000990.KS", "DB하이텍"],
];

// 균등비중 포트폴리오의 일간 수익률 (실제 사용자 상황에 가깝게 5종목 균등)
const dates = h.symbols["005930.KS"].candles.map((c) => c.date);
const closeOf = (s: string) => {
  const m = new Map<string, number>();
  for (const c of h.symbols[s].candles) m.set(c.date, c.close);
  return m;
};
const maps = UNIV.map(([s]) => closeOf(s));
const port: { date: string; ret: number }[] = [];
for (let i = 1; i < dates.length; i++) {
  const rs: number[] = [];
  for (const m of maps) {
    const a = m.get(dates[i - 1]), b = m.get(dates[i]);
    if (a && b) rs.push(b / a - 1);
  }
  if (rs.length === UNIV.length) port.push({ date: dates[i], ret: rs.reduce((x, y) => x + y, 0) / rs.length });
}
const n = port.length;
console.log(`표본: ${n}거래일 (${port[0].date} ~ ${port[n - 1].date}) · 반도체 5종목 균등비중\n`);

// ── ① 큰 손실 다음 날은 어땠나 ─────────────────────────────
console.log("=== ① 크게 잃은 날의 '다음 날' — 물타기가 정당화되는가? ===");
const base = port.reduce((a, x) => a + x.ret, 0) / n;
console.log(`전체 평균 일간수익률: ${(base * 100).toFixed(3)}%\n`);
console.log("당일 손실     표본    다음날 평균    다음날 승률   다음날 최악");
for (const th of [-0.02, -0.03, -0.05, -0.07]) {
  const nxt: number[] = [];
  for (let i = 0; i < n - 1; i++) if (port[i].ret <= th) nxt.push(port[i + 1].ret);
  if (nxt.length < 10) { console.log(`${(th * 100).toFixed(0)}%↓ 이하    ${String(nxt.length).padStart(4)}    (표본 부족)`); continue; }
  const avg = nxt.reduce((a, b) => a + b, 0) / nxt.length;
  const win = (nxt.filter((r) => r > 0).length / nxt.length) * 100;
  const worst = Math.min(...nxt);
  console.log(
    `${(th * 100).toFixed(0)}%↓ 이하    ${String(nxt.length).padStart(4)}    ${(avg * 100 >= 0 ? "+" : "")}${(avg * 100).toFixed(2)}%        ${win.toFixed(0)}%        ${(worst * 100).toFixed(1)}%`,
  );
}
console.log(
  "\n해석: 다음날 평균이 전체 평균과 크게 다르지 않고 승률도 50% 부근이면,\n" +
  "      '많이 빠졌으니 반등한다'는 근거가 없다는 뜻이다 — 물타기의 통계적 근거가 없다.",
);

// ── ② 데일리 스톱 효과 ───────────────────────────────────
// 규칙: 당일 손실이 한도에 닿으면 그날은 더 이상 신규 진입하지 않고,
//       다음 거래일 하루는 관망한다(냉각기간). 보유분은 각자 손절선이 처리한다.
// 재현 방식: 냉각일에는 시장에 노출되지 않는다고 보고 그날 수익률을 0으로 둔다.
console.log("\n=== ② 데일리 스톱 + 하루 냉각기간의 효과 ===");
function simulate(limit: number | null) {
  let eq = 1, peak = 1, mdd = 0, cool = false, stops = 0;
  const daily: number[] = [];
  for (const d of port) {
    const r = cool ? 0 : d.ret;
    if (cool) cool = false;
    else if (limit != null && d.ret <= limit) { cool = true; stops++; }
    eq *= 1 + r;
    daily.push(r);
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, eq / peak - 1);
  }
  const sd = Math.sqrt(daily.reduce((a, b) => a + b * b, 0) / daily.length - (daily.reduce((a, b) => a + b, 0) / daily.length) ** 2);
  return { total: (eq - 1) * 100, mdd: mdd * 100, worst: Math.min(...daily) * 100, stops, sharpe: (daily.reduce((a, b) => a + b, 0) / daily.length) / sd * Math.sqrt(252) };
}
const rows: [string, ReturnType<typeof simulate>][] = [["한도 없음(현재)", simulate(null)]];
for (const L of [-0.03, -0.04, -0.05, -0.07]) rows.push([`${(L * 100).toFixed(0)}% 도달 시 중단`, simulate(L)]);
console.log("규칙                  누적수익    최대낙폭   최악의 날   발동횟수   샤프");
for (const [name, r] of rows)
  console.log(
    `${name.padEnd(20)} ${(r.total >= 0 ? "+" : "")}${r.total.toFixed(0)}%`.padEnd(34) +
    `${r.mdd.toFixed(1)}%`.padStart(8) + `${r.worst.toFixed(1)}%`.padStart(11) +
    `${r.stops}회`.padStart(9) + `${r.sharpe.toFixed(2)}`.padStart(8),
  );
console.log(
  "\n해석: 데일리 스톱은 수익을 늘리는 규칙이 아니다. 누적수익이 줄어도\n" +
  "      최대낙폭과 최악의 날이 줄면 '계좌가 살아남는다'는 목적을 달성한 것이다.\n" +
  "      2천만원 기준 최악의 날 손실액도 함께 본다.",
);
for (const [name, r] of rows)
  console.log(`  ${name.padEnd(20)} 최악의 날 ${Math.round((r.worst / 100) * 20_000_000).toLocaleString()}원`);

// ── ③ 견고성 — 기간을 나눠도 같은 결론인가? ────────────────
// -3%만 좋고 -4%·-5%가 더 나쁘다면 그건 "그 기간에 우연히 맞은 값"일 수 있다.
// 규칙을 앱에 넣으려면 구간을 갈라도 방향이 일관돼야 한다.
console.log("\n=== ③ 견고성 검정 — 기간을 4등분해도 같은 결론인가? ===");
function simRange(from: number, to: number, limit: number | null) {
  let eq = 1, peak = 1, mdd = 0, cool = false;
  const daily: number[] = [];
  for (let i = from; i < to; i++) {
    const d = port[i];
    const r = cool ? 0 : d.ret;
    if (cool) cool = false;
    else if (limit != null && d.ret <= limit) cool = true;
    eq *= 1 + r; daily.push(r);
    peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1);
  }
  return { total: (eq - 1) * 100, mdd: mdd * 100 };
}
const q = Math.floor(n / 4);
console.log("구간              한도없음 MDD   -3% MDD   개선폭    한도없음 수익  -3% 수익");
let better = 0;
for (let k = 0; k < 4; k++) {
  const from = k * q, to = k === 3 ? n : (k + 1) * q;
  const a = simRange(from, to, null), b = simRange(from, to, -0.03);
  const gain = b.mdd - a.mdd; // 양수면 낙폭이 줄었다는 뜻
  if (gain > 0) better++;
  console.log(
    `${port[from].date}~${port[to - 1].date}  ${a.mdd.toFixed(1)}%`.padEnd(38) +
    `${b.mdd.toFixed(1)}%`.padStart(9) + `${gain >= 0 ? "+" : ""}${gain.toFixed(1)}%p`.padStart(10) +
    `${a.total >= 0 ? "+" : ""}${a.total.toFixed(0)}%`.padStart(14) + `${b.total >= 0 ? "+" : ""}${b.total.toFixed(0)}%`.padStart(10),
  );
}
console.log(`\n낙폭이 줄어든 구간: 4개 중 ${better}개`);
console.log(
  better >= 3
    ? "→ 방향이 일관적이다. 규칙으로 채택할 근거가 있다."
    : "→ 구간마다 결과가 갈린다. 특정 기간에만 맞은 값일 가능성이 크므로 강한 규칙으로 쓰면 안 된다.",
);
console.log(
  "\n중요한 한계: 데일리 스톱은 '이미 발생한 그날의 손실'은 막지 못한다(손실이 난 뒤 발동).\n" +
  "  최악의 날 수치가 모든 규칙에서 같은 이유다. 이 규칙이 막는 것은 '그 다음에 이어지는 추격 매매'다.",
);
