// 5개년 일봉 데이터만으로 재현하는 단순 백테스트.
// 장중(분봉)/뉴스/매크로는 과거 시점 재현이 불가능하므로 제외하고,
// 룰 엔진의 일봉 기술적 점수(technicalScore)가 68점 이상이었던 과거 시점을
// "진입 신호"로 보고 5/10거래일 후 종가 수익률을 집계한다.
// 참고용 통계이며, 미래 수익을 보장하지 않는다 (README 참고).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeIndicators } from "../lib/indicators";
import { technicalScore } from "../lib/engine";
import type { BacktestStats, Candle, StockTicker } from "../lib/types";
import { STOCKS, TICKER_LIST } from "../lib/types";

const ENTRY_SCORE_THRESHOLD = 68; // 룰 엔진의 신규매수 임계값과 동일
const MIN_HISTORY_FOR_INDICATORS = 65; // ma60 등 계산에 필요한 최소 일봉 수

function backtestTicker(candles: Candle[]): BacktestStats | null {
  if (candles.length < MIN_HISTORY_FOR_INDICATORS + 15) return null;

  const rets5: number[] = [];
  const rets10: number[] = [];

  for (let i = MIN_HISTORY_FOR_INDICATORS; i < candles.length - 10; i++) {
    const history = candles.slice(0, i + 1);
    const ind = computeIndicators(history);
    if (Number.isNaN(ind.rsi14) || Number.isNaN(ind.ma20)) continue;
    const { score } = technicalScore(ind, candles[i].close);
    if (score < ENTRY_SCORE_THRESHOLD) continue;

    const entryPrice = candles[i].close;
    const p5 = candles[i + 5]?.close;
    const p10 = candles[i + 10]?.close;
    if (p5 != null) rets5.push(((p5 - entryPrice) / entryPrice) * 100);
    if (p10 != null) rets10.push(((p10 - entryPrice) / entryPrice) * 100);
  }

  if (rets5.length === 0) {
    return {
      periodStart: candles[0].date,
      periodEnd: candles[candles.length - 1].date,
      sampleSignals: 0,
      winRate5d: null,
      avgReturn5d: null,
      winRate10d: null,
      avgReturn10d: null,
    };
  }

  const winRate = (rets: number[]) => Math.round((rets.filter((r) => r > 0).length / rets.length) * 1000) / 10;
  const avgReturn = (rets: number[]) => Math.round((rets.reduce((a, b) => a + b, 0) / rets.length) * 100) / 100;

  return {
    periodStart: candles[0].date,
    periodEnd: candles[candles.length - 1].date,
    sampleSignals: rets5.length,
    winRate5d: winRate(rets5),
    avgReturn5d: avgReturn(rets5),
    winRate10d: rets10.length > 0 ? winRate(rets10) : null,
    avgReturn10d: rets10.length > 0 ? avgReturn(rets10) : null,
  };
}

async function main() {
  const dataDir = join(process.cwd(), "data");
  const historyPath = join(dataDir, "market-history.json");
  const raw = JSON.parse(readFileSync(historyPath, "utf-8")) as {
    symbols: Record<string, { name: string; candles: Candle[] }>;
  };

  const perTicker: Partial<Record<StockTicker, BacktestStats>> = {};
  for (const ticker of TICKER_LIST) {
    const yahoo = STOCKS[ticker].yahoo;
    const entry = raw.symbols[yahoo];
    if (!entry) {
      console.warn(`${STOCKS[ticker].name} (${yahoo}): market-history.json에 데이터 없음, 건너뜀`);
      continue;
    }
    const stats = backtestTicker(entry.candles);
    if (stats) {
      perTicker[ticker] = stats;
      console.log(
        `${STOCKS[ticker].name}: 신호 ${stats.sampleSignals}회, 5일 승률 ${stats.winRate5d ?? "-"}%, 평균수익 ${stats.avgReturn5d ?? "-"}%`,
      );
    }
  }

  writeFileSync(
    join(dataDir, "backtest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        disclaimer:
          "5개년 일봉 종가 기준 단순 재현 통계입니다. 장중 변동성·뉴스·매크로 이벤트는 과거 시점으로 재현할 수 없어 제외했으며, 실제 체결가·슬리피지·거래비용도 반영하지 않았습니다. 과거 승률이 미래 수익을 보장하지 않습니다 — 참고 지표로만 사용하세요.",
        entryScoreThreshold: ENTRY_SCORE_THRESHOLD,
        perTicker,
      },
      null,
      1,
    ),
  );
  console.log("=== 백테스트 완료: data/backtest.json ===");
}

main().catch((e) => {
  console.error("백테스트 실패:", e);
  process.exitCode = 1;
});
