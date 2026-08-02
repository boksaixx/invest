// 상관 비중 캡 검증 — "상관이 높은 두 종목의 합산 비중을 제한하면 실제로 덜 맞는가"
//
// 실행: npx tsx scripts/validate-correlation-cap.ts
//
// 왜 필요한가: 지금 엔진은 한 종목 최대 비중만 50%로 제한한다. 그러면 삼성전자 50% +
// SK하이닉스 50% = 100%가 규칙상 통과된다. 그런데 이 둘의 상관은 0.86이라 사실상 한 종목에
// 전액을 넣은 것과 다르지 않다. "종목을 나눴으니 분산됐다"는 착시가 규칙 안에 남아 있는 셈이다.
//
// 그래서 합산 비중 캡을 도입할지 말지를 실제 5개년 일별 수익률로 판정한다. 캡을 씌우면
// 위험이 줄지만 수익도 준다 — 그 교환비를 눈으로 보고 수준을 정한다.
//
// 비교 방식: 남는 비중은 현금(수익률 0)으로 둔다. 레버리지를 쓰지 않는 실제 계좌와 같다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../lib/types";

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

// 검증 대상 쌍 — 상관이 가장 높은 조합부터
const PAIRS: [string, string][] = [
  ["005930.KS", "000660.KS"], // 삼성전자 · SK하이닉스
  ["000660.KS", "042700.KS"], // SK하이닉스 · 한미반도체 (HBM 밸류체인)
];
const CAPS = [0.4, 0.5, 0.6, 0.7, 1.0]; // 두 종목 합산 비중 상한
const PERIODS: { label: string; days: number }[] = [
  { label: "5년 전체", days: 1230 },
  { label: "최근 1년", days: 250 },
  { label: "최근 6개월(급변동)", days: 122 },
];

function corrOf(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
}

/** 두 종목을 반반씩 cap 비중만큼 담고 나머지는 현금인 포트폴리오의 성적. */
function simulate(rA: number[], rB: number[], cap: number) {
  const w = cap / 2;
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  const daily: number[] = [];
  for (let i = 0; i < rA.length; i++) {
    const r = w * rA[i] + w * rB[i]; // 단순수익률 가중 (일별 리밸런싱 가정)
    daily.push(r * 100);
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    mdd = Math.max(mdd, 1 - equity / peak);
  }
  const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / daily.length);
  const sorted = [...daily].sort((a, b) => a - b);
  return {
    totalPct: (equity - 1) * 100,
    sigmaPct: sd,
    worstDayPct: sorted[0],
    worst5AvgPct: sorted.slice(0, 5).reduce((a, b) => a + b, 0) / 5,
    mddPct: mdd * 100,
  };
}

function main() {
  const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;
  const ASSET = 20_000_000; // 실제 운용 규모 — 위험을 % 대신 금액으로도 보여주기 위함

  console.log("=== 상관 비중 캡 검증 (2천만원 기준) ===");
  console.log("남는 비중은 현금(수익률 0). 레버리지 없음 — 실제 계좌와 동일 조건\n");

  for (const [symA, symB] of PAIRS) {
    const A = hist.symbols[symA];
    const B = hist.symbols[symB];
    if (!A || !B) continue;

    // 공통 거래일 기준 단순수익률
    const mapB = new Map(B.candles.map((c) => [c.date, c.close]));
    const dates: string[] = [];
    const rA: number[] = [];
    const rB: number[] = [];
    for (let i = 1; i < A.candles.length; i++) {
      const d = A.candles[i].date;
      const pa0 = A.candles[i - 1].close;
      const pa1 = A.candles[i].close;
      const pb1 = mapB.get(d);
      const prevDate = A.candles[i - 1].date;
      const pb0 = mapB.get(prevDate);
      if (!(pa0 > 0 && pa1 > 0 && pb0 && pb1 && pb0 > 0 && pb1 > 0)) continue;
      dates.push(d);
      rA.push(pa1 / pa0 - 1);
      rB.push(pb1 / pb0 - 1);
    }

    for (const { label, days } of PERIODS) {
      const sA = rA.slice(-days);
      const sB = rB.slice(-days);
      if (sA.length < 60) continue;
      const rho = corrOf(
        sA.map((x) => Math.log(1 + x)),
        sB.map((x) => Math.log(1 + x)),
      );
      console.log(`■ ${A.name} + ${B.name} — ${label} (${sA.length}일, 상관 ${rho.toFixed(2)})`);
      console.log(
        "  합산비중".padEnd(10) +
          "누적수익".padStart(10) +
          "일변동성".padStart(10) +
          "최악의날".padStart(10) +
          "최대낙폭".padStart(10) +
          "위험대비수익".padStart(13) +
          "최악의날 금액".padStart(15),
      );
      for (const cap of CAPS) {
        const r = simulate(sA, sB, cap);
        // 누적수익 ÷ 최대낙폭 — 캡을 바꿔도 이 값이 거의 안 변하면 "캡은 수익을 개선하지 않는다"는 뜻
        const rar = r.mddPct > 0 ? r.totalPct / r.mddPct : NaN;
        console.log(
          `  ${(cap * 100).toFixed(0)}%`.padEnd(10) +
            `${r.totalPct >= 0 ? "+" : ""}${r.totalPct.toFixed(1)}%`.padStart(10) +
            `${r.sigmaPct.toFixed(2)}%`.padStart(10) +
            `${r.worstDayPct.toFixed(1)}%`.padStart(10) +
            `${r.mddPct.toFixed(1)}%`.padStart(10) +
            `${rar.toFixed(2)}`.padStart(13) +
            `${Math.round((r.worstDayPct / 100) * ASSET).toLocaleString()}원`.padStart(15),
        );
      }
      console.log();
    }
  }

  console.log("해석 (정직하게)");
  console.log("- 캡을 낮추면 위험도 수익도 거의 비례해서 준다. '위험대비수익' 열이 캡을 바꿔도");
  console.log("  거의 그대로인 게 그 증거다. 즉 이 캡은 수익을 개선하는 규칙이 아니다.");
  console.log("- 그런데도 캡이 필요한 이유는 두 가지다.");
  console.log("  ① 착시 제거: 상관 0.9면 두 종목에 반반 담아도 위험은 한 종목에 전액 넣은 것과 같다.");
  console.log("     지금 규칙(종목당 50%)은 삼성전자 50% + 하이닉스 50% = 100%를 '분산'으로 통과시킨다.");
  console.log("  ② 생존: 최악의 날 손실을 견딜 수 있는 크기로 묶어둔다. 캡을 100%로 두면 하루에");
  console.log("     2천만원 기준 -280만원이 났고, 50%면 -140만원이었다.");
  console.log("- 그래서 캡은 '더 벌기 위한 규칙'이 아니라 '계좌가 살아남게 하는 한도'로 제시해야 한다.");
  console.log("- 이 검증은 과거 재현이며, 강세 구간이 포함된 누적수익은 미래 보장이 아니다.");
}

main();
