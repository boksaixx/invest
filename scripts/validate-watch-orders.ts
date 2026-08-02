// 자동 감시주문(스탑로스/익절 예약) 검증 — "차트를 못 보는 동안 예약주문이 실제로 도움이 되는가"
//
// 실행: npx tsx scripts/validate-watch-orders.ts
//
// 왜 필요한가: 사용자가 장중에 앱을 보는 시간이 불규칙하다. 손절선을 "머리로만" 정해두면
// 자리를 비운 사이에 그 선을 지나쳐 훨씬 나쁜 가격에 끝날 수 있다. 반대로 예약을 걸어두면
// 잠깐 스치고 되돌아오는 날에도 기계적으로 털린다. 어느 쪽이 나은지는 감이 아니라 데이터로
// 정해야 한다.
//
// 비교 대상 (진입은 시가, 손절/목표는 엔진의 실제 규칙과 동일하게 ATR 기반)
//  A. 감시주문 있음 : 보유 기간 중 저가가 손절선을 건드리면 손절가에 체결, 고가가 목표가를
//                    건드리면 목표가에 체결. 아무것도 안 닿으면 기간 끝 종가 청산
//  B. 감시주문 없음 : 기간 끝 종가에만 청산 (그 사이엔 차트를 못 본다)
//
// 보유 기간을 1일뿐 아니라 3일·5일로도 본다. 사용자의 실제 걱정은 "몇 시간 자리를 비운 사이"가
// 아니라 "며칠 못 보는 사이 급락"이기 때문이다. 1일만 보면 감시주문의 값어치가 과소평가된다.
//
// 보수적 가정: 손절·목표를 같은 날 둘 다 건드린 경우 손절이 먼저 걸린 것으로 본다.
// 일봉만으로는 순서를 알 수 없으므로, 감시주문 쪽에 불리한 쪽으로 가정했다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeIndicators } from "../lib/indicators";
import type { Candle } from "../lib/types";

const KR = [
  { sym: "005930.KS", label: "삼성전자" },
  { sym: "000660.KS", label: "SK하이닉스" },
  { sym: "009150.KS", label: "삼성전기" },
  { sym: "042700.KS", label: "한미반도체" },
  { sym: "000990.KS", label: "DB하이텍" },
];
const ROUND_TRIP = 0.25; // 왕복 거래비용(%) — 양쪽 모두 동일하게 차감하므로 비교에는 중립
const HOLD_DAYS = [1, 3, 5]; // 차트를 못 보는 기간 (거래일)
const PERIODS = [
  { label: "5년 전체", days: 1230 },
  { label: "최근 1년", days: 250 },
  { label: "최근 6개월(급변동)", days: 122 },
];

type Hist = { symbols: Record<string, { name: string; candles: Candle[] }> };

function main() {
  const hist = JSON.parse(readFileSync(join(process.cwd(), "data", "market-history.json"), "utf8")) as Hist;

  console.log("=== 자동 감시주문 효과 검증 ===");
  console.log("시가 진입 → 엔진과 동일한 ATR 손절/목표(손익비 1:2). 거래비용 왕복 0.25% 차감\n");

  for (const { label: periodLabel, days } of PERIODS) {
    console.log(`■ ${periodLabel}`);
    console.log(
      "  못 보는 기간".padEnd(15) +
        "구분".padEnd(16) +
        "건당 평균".padStart(10) +
        "최악".padStart(9) +
        "하위5%".padStart(9) +
        "손실 -10%↓ 비율".padStart(16),
    );
    for (const hold of HOLD_DAYS) {
      const withOrder: number[] = [];
      const withoutOrder: number[] = [];
      let stopFirst = 0;
      let rescued = 0; // 감시주문이 실제로 손실을 줄인 건
      let whipsawed = 0; // 스치고 되돌아와 손해였던 건
      let rescuedSum = 0;
      let whipsawSum = 0;

      for (const { sym } of KR) {
        const c = hist.symbols[sym]?.candles ?? [];
        if (c.length < 300) continue;
        const start = Math.max(60, c.length - days);
        for (let t = start; t + hold - 1 < c.length; t++) {
          // 그 시점까지의 캔들만으로 ATR 산출 (미래 정보 없음)
          const ind = computeIndicators(c.slice(0, t));
          const d0 = c[t];
          if (!(d0.open > 0 && d0.high > 0 && d0.low > 0 && d0.close > 0)) continue;
          const entry = d0.open;
          const stopDist = isNaN(ind.atr14) ? entry * 0.03 : Math.max(ind.atr14 * 1.5, entry * 0.02);
          const stop = entry - stopDist;
          const target = entry + stopDist * 2;
          if (!(stop > 0)) continue;

          const pct = (exit: number) => (exit / entry - 1) * 100 - ROUND_TRIP;
          const last = c[t + hold - 1];
          if (!(last.close > 0)) continue;
          const holdPct = pct(last.close); // 못 보는 동안 아무것도 안 한 결과

          // 감시주문: 보유 기간 안에서 먼저 닿는 쪽에 체결 (같은 날 둘 다면 손절 우선 — 보수적)
          let orderPct = holdPct;
          for (let k = 0; k < hold; k++) {
            const d = c[t + k];
            if (!(d.low > 0 && d.high > 0)) continue;
            if (d.low <= stop) {
              orderPct = pct(stop);
              stopFirst++;
              break;
            }
            if (d.high >= target) {
              orderPct = pct(target);
              break;
            }
          }
          const diff = orderPct - holdPct;
          if (diff > 0.01) {
            rescued++;
            rescuedSum += diff;
          } else if (diff < -0.01) {
            whipsawed++;
            whipsawSum += -diff;
          }
          withOrder.push(orderPct);
          withoutOrder.push(holdPct);
        }
      }
      if (withOrder.length === 0) continue;

      const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      const worst = (a: number[]) => Math.min(...a);
      const p5 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.05)];
      const bigLossPct = (a: number[]) => (a.filter((x) => x <= -10).length / a.length) * 100;

      for (const [name, arr] of [
        ["감시주문 있음", withOrder],
        ["감시주문 없음", withoutOrder],
      ] as [string, number[]][]) {
        console.log(
          (name === "감시주문 있음" ? `  ${hold}거래일` : "  ").padEnd(15) +
            name.padEnd(16) +
            `${avg(arr) >= 0 ? "+" : ""}${avg(arr).toFixed(2)}%`.padStart(10) +
            `${worst(arr).toFixed(1)}%`.padStart(9) +
            `${p5(arr).toFixed(1)}%`.padStart(9) +
            `${bigLossPct(arr).toFixed(1)}%`.padStart(16),
        );
      }
      console.log(
        `                 └ 감시주문이 손실 줄인 건 ${rescued}회(평균 ${(rescuedSum / Math.max(1, rescued)).toFixed(1)}%p) / ` +
          `스치고 되돌아와 손해 본 건 ${whipsawed}회(평균 ${(whipsawSum / Math.max(1, whipsawed)).toFixed(1)}%p), 손절 발동 ${stopFirst}회`,
      );
    }
    console.log();
  }

  console.log("해석 (정직하게)");
  console.log("- '최악'·'하위5%'·'-10% 이하 비율'이 감시주문의 존재 이유다. 꼬리 손실이 잘리는지 본다.");
  console.log("- 건당 평균이 감시주문 쪽에서 더 낮게 나오면, 그건 '더 번다'는 근거가 아니라는 뜻이다.");
  console.log("  그 경우 감시주문은 수익 개선책이 아니라 최악을 제한하는 보험으로만 제시해야 한다.");
  console.log("- 일봉만으로는 손절·목표 중 무엇이 먼저 닿았는지 알 수 없어, 둘 다 닿은 날은");
  console.log("  손절이 먼저인 것으로 보수적으로 가정했다(감시주문에 불리한 방향).");
  console.log("- 진입 시점을 신호와 무관하게 매일 시가로 잡았으므로 절대 수익률 자체는 의미가 없다.");
  console.log("  두 방식의 '차이'만 보면 된다.");
}

main();
