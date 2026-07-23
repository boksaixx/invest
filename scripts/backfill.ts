// 5개년 과거 데이터 백필: 국내 5종목(삼성전자 등)+미국 4종목(테슬라 등)+코스피/환율/해외지수 일봉을 저장소에 적재
// GitHub Actions에서 data/market-history.json 이 없을 때, 또는 주간 스케줄로 자동 실행됨.
// 이미 저장된 심볼은 건너뛰고 새로 추가된 심볼만 받아오는 증분 방식이라(merge), 기존 파일이 있는
// 상태에서 SYMBOLS에 새 종목을 추가해도 그 종목만 5년치를 새로 받아오면 된다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchDailyCandles } from "../lib/market";
import type { Candle } from "../lib/types";

const SYMBOLS: { symbol: string; name: string }[] = [
  { symbol: "005930.KS", name: "삼성전자" },
  { symbol: "000660.KS", name: "SK하이닉스" },
  { symbol: "042700.KS", name: "한미반도체" },
  { symbol: "009150.KS", name: "삼성전기" },
  { symbol: "000990.KS", name: "DB하이텍" },
  { symbol: "TSLA", name: "테슬라" },
  { symbol: "NVDA", name: "엔비디아" },
  { symbol: "GOOGL", name: "구글(알파벳)" },
  { symbol: "META", name: "메타" },
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
  const dir = join(process.cwd(), "data");
  const filePath = join(dir, "market-history.json");
  const out: Record<string, { name: string; candles: Candle[] }> = {};
  if (existsSync(filePath)) {
    try {
      const prev = JSON.parse(readFileSync(filePath, "utf8")) as { symbols?: Record<string, { name: string; candles: Candle[] }> };
      Object.assign(out, prev.symbols ?? {});
    } catch {
      // 기존 파일 파싱 실패 시 처음부터 다시 받는다
    }
  }
  for (const { symbol, name } of SYMBOLS) {
    if (out[symbol] && out[symbol].candles.length > 100) {
      console.log(`${name} (${symbol}): 이미 있음, 건너뜀 (${out[symbol].candles.length}개)`);
      continue;
    }
    const candles = await fetchDailyCandles(symbol, "5y");
    console.log(`${name} (${symbol}): ${candles.length}개 일봉`);
    out[symbol] = { name, candles };
    await new Promise((r) => setTimeout(r, 800)); // 요청 간격 (rate limit 예방)
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify({ generatedAt: new Date().toISOString(), symbols: out }, null, 1));
  console.log("=== 백필 완료: data/market-history.json ===");
}

main().catch((e) => {
  console.error("백필 실패:", e);
  process.exitCode = 1;
});
