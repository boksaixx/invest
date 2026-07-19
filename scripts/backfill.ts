// 5개년 과거 데이터 백필: 삼성전자/SK하이닉스/코스피/환율/해외지수 일봉을 저장소에 적재
// GitHub Actions에서 data/market-history.json 이 없을 때 자동 실행됨
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchDailyCandles } from "../lib/market";
import type { Candle } from "../lib/types";

const SYMBOLS: { symbol: string; name: string }[] = [
  { symbol: "005930.KS", name: "삼성전자" },
  { symbol: "000660.KS", name: "SK하이닉스" },
  { symbol: "042700.KS", name: "한미반도체" },
  { symbol: "009150.KS", name: "삼성전기" },
  { symbol: "000990.KS", name: "DB하이텍" },
  { symbol: "^KS11", name: "코스피" },
  { symbol: "KRW=X", name: "원달러환율" },
  { symbol: "^IXIC", name: "나스닥" },
  { symbol: "^SOX", name: "필라델피아반도체" },
  { symbol: "^N225", name: "니케이225" },
  { symbol: "000001.SS", name: "상해종합" },
  { symbol: "^VIX", name: "VIX변동성지수" },
];

async function main() {
  console.log("=== 5개년 데이터 백필 시작 ===");
  const out: Record<string, { name: string; candles: Candle[] }> = {};
  for (const { symbol, name } of SYMBOLS) {
    const candles = await fetchDailyCandles(symbol, "5y");
    console.log(`${name} (${symbol}): ${candles.length}개 일봉`);
    out[symbol] = { name, candles };
    await new Promise((r) => setTimeout(r, 800)); // 요청 간격 (rate limit 예방)
  }
  const dir = join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "market-history.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), symbols: out }, null, 1),
  );
  console.log("=== 백필 완료: data/market-history.json ===");
}

main().catch((e) => {
  console.error("백필 실패:", e);
  process.exitCode = 1;
});
