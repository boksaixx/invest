// 기간별 수익성 검증 — "플레이북대로 샀다 팔았다" vs "그냥 보유" vs "보유하며 트레이딩"
//
// 실행: npx tsx scripts/validate-holding.ts
//
// 삼성전자·SK하이닉스를 대상으로 최근 1주/1개월/6개월 구간에서 세 가지 운용을 비교한다.
//
// 전략 정의
//  A. 플레이북매매 : lib/genius.ts 규칙대로 현금에서 출발해 조건 충족 시에만 진입/청산 (인앤아웃)
//     - 폭락장(전일 SOX -3.5%↓ 또는 당일 종가 -N%↓): 종가 매수 → 익일 종가 청산
//     - 그 외: 시가 -0.6σ 지정가 매수 → +1.0σ 익절 / -0.8σ 손절 / 미달 시 종가 청산
//  B. 단순보유   : 첫날 시가에 전량 매수 후 마지막 날 종가까지 그대로 보유
//  C. 보유+트레이딩: 전량 보유를 기본으로, +12%↑ 급등 다음날 +3% 지정가에 절반 익절,
//     이후 -N%↓ 폭락일 종가에 그 절반을 재매수 (코어 보유 + 주변 트레이딩)
//
// 공통 가정 (모두 보수적)
//  - 왕복 거래비용 0.25% (매수 0.015% / 매도 0.235%)를 체결마다 차감
//  - 하루 안에 익절가·손절가를 모두 건드린 날은 "손절 먼저"로 처리(최악 순서)
//  - 지정가 체결은 저가가 지정가 이하로 내려온 날만 인정, 미체결이면 그날 매매 없음
//  - 미래 정보 미사용: 각 시점에서 그날까지의 데이터만으로 판단
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GENIUS_DIP_SIGMA, GENIUS_STOP_SIGMA, GENIUS_TARGET_SIGMA, CRASH_REBOUND_MAX_WEIGHT } from "../lib/genius";
import type { Candle } from "../lib/types";

const BUY_COST = 0.00015;
const SELL_COST = 0.00235;
const TARGETS = [
  { sym: "005930.KS", label: "삼성전자" },
  { sym: "000660.KS", label: "SK하이닉스" },
];
const WINDOWS: [string, number][] = [
  ["최근 1주일", 5],
  ["최근 1개월", 21],
  ["최근 6개월", 122],
];

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

function ewmaSigma(c: Candle[], upto: number): number {
  const rs: number[] = [];
  for (let i = Math.max(1, upto - 200); i <= upto; i++) rs.push(Math.log(c[i].close / c[i - 1].close) * 100);
  let v = rs.slice(0, 20).reduce((a, b) => a + b * b, 0) / 20;
  for (const r of rs) v = 0.94 * v + 0.06 * r * r;
  return Math.sqrt(v);
}

interface Result {
  finalPct: number; // 최종 수익률 (%)
  trades: number;
  wins: number;
  maxDrawdownPct: number;
  log: string[];
}

// 자산 곡선에서 최대 낙폭 계산
function mdd(equity: number[]): number {
  let peak = equity[0] ?? 1;
  let worst = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > worst) worst = dd;
  }
  return worst * 100;
}

function simulate(
  candles: Candle[],
  startIdx: number,
  endIdx: number,
  strategy: "플레이북" | "보유" | "보유+트레이딩",
  crashPct: number,
  prevSox: (d: string) => number | null,
): Result {
  const START = 10_000_000; // 1천만원 기준 (비율만 보므로 절대액은 무관)
  let cash = START;
  let shares = 0;
  let trades = 0;
  let wins = 0;
  const log: string[] = [];
  const equity: number[] = [];
  // 폭락 반등으로 산 물량(익일 종가 청산 예정)
  let reboundShares = 0;
  let reboundCost = 0;
  // 급등 익절로 걸어둔 매도 지정가 (다음날 유효)
  let pendingSellLimit: number | null = null;
  let trimmedShares = 0; // 익절해 둔 수량 (재매수 대기)

  const buy = (price: number, qty: number) => {
    const cost = qty * price * (1 + BUY_COST);
    if (cost > cash || qty <= 0) return 0;
    cash -= cost;
    shares += qty;
    return qty;
  };
  const sell = (price: number, qty: number) => {
    const q = Math.min(qty, shares);
    if (q <= 0) return 0;
    cash += q * price * (1 - SELL_COST);
    shares -= q;
    return q;
  };

  if (strategy === "보유" || strategy === "보유+트레이딩") {
    // 첫날 시가에 전량 매수
    const p = candles[startIdx].open;
    buy(p, Math.floor(cash / (p * (1 + BUY_COST))));
  }

  for (let t = startIdx; t <= endIdx; t++) {
    const x = candles[t];
    const prev = candles[t - 1];
    const todayChg = ((x.close - prev.close) / prev.close) * 100;
    const sox = prevSox(x.date);

    // --- 1) 전날 걸어둔 급등 익절 지정가 체결 확인 (장중 고가 도달 시) ---
    if (pendingSellLimit != null) {
      if (x.high >= pendingSellLimit) {
        const q = Math.floor(shares / 2);
        const sold = sell(pendingSellLimit, q);
        if (sold > 0) {
          trimmedShares = sold;
          trades++;
          wins++; // 익절 체결은 정의상 이익 실현
          log.push(`${x.date} 급등익절 ${sold}주 @${Math.round(pendingSellLimit).toLocaleString()}`);
        }
      }
      pendingSellLimit = null;
    }

    // --- 2) 어제 폭락 반등으로 산 물량은 오늘 종가에 청산 ---
    if (reboundShares > 0) {
      const proceeds = reboundShares * x.close * (1 - SELL_COST);
      const pnl = proceeds - reboundCost;
      cash += proceeds;
      shares -= reboundShares;
      trades++;
      if (pnl > 0) wins++;
      log.push(`${x.date} 폭락반등 청산 ${reboundShares}주 @${Math.round(x.close).toLocaleString()} (${pnl >= 0 ? "+" : ""}${Math.round(pnl / 10000)}만원)`);
      reboundShares = 0;
      reboundCost = 0;
    }

    // --- 3) 플레이북 매매: 눌림목 지정가 (폭락장이 아닐 때만) ---
    if (strategy === "플레이북" && t >= 25) {
      const r1 = ((prev.close - candles[t - 2].close) / candles[t - 2].close) * 100;
      const r2 = ((candles[t - 2].close - candles[t - 3].close) / candles[t - 3].close) * 100;
      const knife = r1 <= -8 || (r1 <= -5 && r2 <= -5); // 칼날 필터
      const soxCrash = sox != null && sox <= -3.5;
      if (!knife && !soxCrash && shares === 0) {
        const sigma = ewmaSigma(candles, t - 1);
        const entry = x.open * (1 - (GENIUS_DIP_SIGMA * sigma) / 100);
        if (x.low <= entry) {
          const qty = Math.floor(cash / (entry * (1 + BUY_COST)));
          if (qty > 0) {
            buy(entry, qty);
            const stop = entry * (1 - (GENIUS_STOP_SIGMA * sigma) / 100);
            const target = entry * (1 + (GENIUS_TARGET_SIGMA * sigma) / 100);
            let exitPrice: number;
            let tag: string;
            if (x.low <= stop) {
              exitPrice = stop;
              tag = "손절";
            } else if (x.high >= target) {
              exitPrice = target;
              tag = "익절";
            } else {
              exitPrice = x.close;
              tag = "종가청산";
            }
            sell(exitPrice, qty);
            trades++;
            if (exitPrice > entry) wins++;
            log.push(`${x.date} 눌림목 ${tag} ${qty}주 ${Math.round(entry).toLocaleString()}→${Math.round(exitPrice).toLocaleString()} (${(((exitPrice / entry) - 1) * 100).toFixed(1)}%)`);
          }
        }
      }
    }

    // --- 4) 종가 기준 이벤트 처리 ---
    // 4a) 폭락일 종가 매수 (플레이북: 소액 / 보유+트레이딩: 익절해둔 물량 재매수)
    if (todayChg <= crashPct) {
      if (strategy === "플레이북") {
        const budget = (cash + shares * x.close) * CRASH_REBOUND_MAX_WEIGHT;
        const qty = Math.floor(Math.min(budget, cash) / (x.close * (1 + BUY_COST)));
        if (qty > 0) {
          buy(x.close, qty);
          reboundShares = qty;
          reboundCost = qty * x.close * (1 + BUY_COST);
          log.push(`${x.date} 폭락(${todayChg.toFixed(1)}%) 반등매수 ${qty}주 @${Math.round(x.close).toLocaleString()}`);
        }
      } else if (strategy === "보유+트레이딩" && trimmedShares > 0) {
        const qty = Math.min(trimmedShares, Math.floor(cash / (x.close * (1 + BUY_COST))));
        if (qty > 0) {
          buy(x.close, qty);
          trimmedShares -= qty;
          trades++;
          log.push(`${x.date} 폭락(${todayChg.toFixed(1)}%) 재매수 ${qty}주 @${Math.round(x.close).toLocaleString()}`);
        }
      }
    }
    // 4b) 급등일 → 내일 +3% 지정가 매도 예약 (보유 물량이 있을 때만)
    if (strategy === "보유+트레이딩" && todayChg >= 12 && shares > 0) {
      pendingSellLimit = x.close * 1.03;
    }

    equity.push(cash + shares * x.close);
  }

  // 마지막 날 종가로 전량 청산해 최종 평가
  const last = candles[endIdx].close;
  const finalValue = cash + shares * last * (1 - SELL_COST);
  return {
    finalPct: (finalValue / START - 1) * 100,
    trades,
    wins,
    maxDrawdownPct: mdd(equity),
    log,
  };
}

function main() {
  const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;
  const soxC = hist.symbols["^SOX"].candles;
  const soxRet = new Map<string, number>();
  for (let i = 1; i < soxC.length; i++) soxRet.set(soxC[i].date, (soxC[i].close / soxC[i - 1].close - 1) * 100);
  const soxDates = soxC.map((c) => c.date);
  const cache = new Map<string, number | null>();
  const prevSox = (d: string): number | null => {
    if (cache.has(d)) return cache.get(d)!;
    let best: string | null = null;
    for (const x of soxDates) if (x < d && (!best || x > best)) best = x;
    const v = best ? soxRet.get(best) ?? null : null;
    cache.set(d, v);
    return v;
  };

  const CRASH = -7; // lib/genius.ts 의 폭락장 판정 기준과 동일
  console.log("=== 기간별 수익성 검증: 플레이북 매매 vs 단순 보유 ===");
  console.log(`데이터 기준일: ${hist.symbols["005930.KS"].candles.slice(-1)[0].date} (주간 백필 주기라 최신 며칠은 빠져 있을 수 있음)`);
  console.log(`거래비용 왕복 0.25% 차감 | 익절·손절 동시 접촉일은 손절 처리(최악 가정) | 폭락 기준 ${CRASH}%\n`);

  for (const { sym, label } of TARGETS) {
    const c = hist.symbols[sym].candles;
    console.log(`\n${"=".repeat(58)}\n■ ${label}\n${"=".repeat(58)}`);
    for (const [wname, wdays] of WINDOWS) {
      const endIdx = c.length - 1;
      const startIdx = Math.max(30, endIdx - wdays + 1);
      const from = c[startIdx].date;
      const to = c[endIdx].date;
      const holdPct = ((c[endIdx].close / c[startIdx].open - 1) * 100);
      console.log(`\n[${wname}] ${from} ~ ${to} (${endIdx - startIdx + 1}거래일)`);
      const rows: [string, Result][] = [
        ["플레이북 매매", simulate(c, startIdx, endIdx, "플레이북", CRASH, prevSox)],
        ["단순 보유", simulate(c, startIdx, endIdx, "보유", CRASH, prevSox)],
        ["보유+트레이딩", simulate(c, startIdx, endIdx, "보유+트레이딩", CRASH, prevSox)],
      ];
      for (const [nm, r] of rows) {
        const sign = r.finalPct >= 0 ? "+" : "";
        console.log(
          `  ${nm.padEnd(14)} ${sign}${r.finalPct.toFixed(2).padStart(7)}%  | 매매 ${String(r.trades).padStart(2)}회` +
            (r.trades ? ` 승률 ${((r.wins / r.trades) * 100).toFixed(0).padStart(3)}%` : "         ") +
            ` | 최대낙폭 ${r.maxDrawdownPct.toFixed(1).padStart(5)}%`,
        );
      }
      console.log(`  (참고) 종가 기준 단순 등락률 ${holdPct >= 0 ? "+" : ""}${holdPct.toFixed(2)}%`);
      // 1주/1개월은 표본이 작아 매매 로그를 그대로 보여준다
      if (wdays <= 21) {
        const pb = rows[0][1];
        if (pb.log.length) {
          console.log("  플레이북 매매 내역:");
          for (const l of pb.log) console.log(`    ${l}`);
        } else {
          console.log("  플레이북 매매 내역: (조건 미충족 — 매매 없음)");
        }
      }
    }
  }

  console.log(`\n${"=".repeat(58)}`);
  console.log("해석 시 주의");
  console.log("- 1주일(5거래일)은 표본이 너무 작아 운의 영향이 절대적입니다. 추세 판단용으로 쓰지 마세요.");
  console.log("- 플레이북은 '조건이 맞는 날에만' 진입하므로, 매매 0회로 끝나는 구간이 정상입니다.");
  console.log("- 단순 보유는 상승장에서 유리하고 하락장에서 그대로 맞습니다. 플레이북은 그 반대 성향입니다.");
  console.log("- 모두 과거 재현이며 미래 보장이 아닙니다.");
}

main();
