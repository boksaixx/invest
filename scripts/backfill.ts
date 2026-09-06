// 5개년 과거 데이터 백필 — 추적 종목 + 매크로 지수의 일봉을 저장소에 적재한다.
//
// 추적 종목 목록은 lib/types.ts의 TICKER_LIST에서 그대로 가져온다.
// 예전에는 여기에 종목을 손으로 다시 적었는데, 종목을 추가할 때 한쪽만 고치면
// "앱은 추적하는데 5년 히스토리는 없는" 상태가 조용히 생긴다 — 실제로 비반도체 5종목이
// 그렇게 빠져 있었다(백테스트·국면통계·상승률이 전부 계산되지 않는 상태).
// 이제 종목을 추가하면 자동으로 백필 대상이 되고, hasMissingHistory()가 그 사실을 알린다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dropInProgressCandle, fetchDailyCandles, fetchUpbitDaily } from "../lib/market";
import type { Candle } from "../lib/types";
import { STOCKS, TICKER_LIST } from "../lib/types";

/** 매크로·지수 — 종목이 아니라 판단 배경이 되는 시계열 */
const MACRO_SYMBOLS: { symbol: string; name: string }[] = [
  { symbol: "^KS11", name: "코스피" },
  { symbol: "KRW=X", name: "원달러환율" },
  { symbol: "^IXIC", name: "나스닥" },
  { symbol: "^SOX", name: "필라델피아반도체" },
  { symbol: "^N225", name: "니케이225" },
  { symbol: "000001.SS", name: "상해종합" },
  { symbol: "^VIX", name: "VIX변동성지수" },
  { symbol: "CL=F", name: "WTI원유" },
  { symbol: "^TNX", name: "미10년물국채금리" }, // 점수 반영 전 검증용 히스토리 축적
];

/** 추적 종목(TICKER_LIST) + 매크로 = 백필 대상 전체 */
const SYMBOLS: { symbol: string; name: string }[] = [
  ...TICKER_LIST.map((t) => ({ symbol: STOCKS[t].yahoo, name: STOCKS[t].name })),
  ...MACRO_SYMBOLS,
];

/** 히스토리가 비어 있는 추적 종목 목록 — 워크플로가 "지금 백필해야 하나"를 판단하는 데 쓴다 */
export function missingHistory(): string[] {
  const filePath = join(process.cwd(), "data", "market-history.json");
  if (!existsSync(filePath)) return SYMBOLS.map((s) => s.name);
  try {
    const prev = JSON.parse(readFileSync(filePath, "utf8")) as { symbols?: Record<string, { candles: Candle[] }> };
    const have = prev.symbols ?? {};
    return SYMBOLS.filter(({ symbol }) => !have[symbol] || have[symbol].candles.length <= 100).map((s) => s.name);
  } catch {
    return SYMBOLS.map((s) => s.name);
  }
}

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
    const existing = out[symbol]?.candles ?? [];
    // 가상자산(업비트 마켓 코드 KRW-*)은 업비트에서 받는다 — 5년치는 200개씩 약 10회 페이지네이션
    const cryptoTicker = TICKER_LIST.find((t) => STOCKS[t].yahoo === symbol && STOCKS[t].market === "CRYPTO");
    if (cryptoTicker) {
      const fresh = dropInProgressCandle(await fetchUpbitDaily(cryptoTicker, existing.length > 100 ? 400 : 1900), new Date(), "CRYPTO");
      const byDate = new Map(existing.map((c) => [c.date, c]));
      let added = 0;
      for (const c of fresh) {
        if (!byDate.has(c.date)) added++;
        byDate.set(c.date, c);
      }
      const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      out[symbol] = { name, candles: merged };
      console.log(`${name} (${symbol}, 업비트): +${added}개 (총 ${merged.length}개, ${merged[0]?.date} ~ ${merged[merged.length - 1]?.date})`);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (existing.length > 100) {
      // 2026-09 감사: 예전에는 "이미 있음"이면 건너뛰어 히스토리가 2026-07-31에서 영영 멈췄고,
      // 매주 일요일 "재생성"되는 국면통계·도달확률·백테스트가 전부 낡은 데이터로 돌면서
      // generatedAt만 갱신됐다. 이제 최근 1년치를 받아 날짜 기준으로 덧붙인다(진행 중인 오늘 봉 제외).
      const recent = dropInProgressCandle(await fetchDailyCandles(symbol, "1y"));
      const byDate = new Map(existing.map((c) => [c.date, c]));
      let added = 0;
      for (const c of recent) {
        if (!byDate.has(c.date)) added++;
        byDate.set(c.date, c); // 같은 날짜는 최신 응답으로 덮는다(수정 종가 반영)
      }
      const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      out[symbol] = { name, candles: merged };
      console.log(`${name} (${symbol}): 갱신 +${added}개 (총 ${merged.length}개, 마지막 ${merged[merged.length - 1]?.date})`);
    } else {
      const candles = dropInProgressCandle(await fetchDailyCandles(symbol, "5y"));
      console.log(`${name} (${symbol}): ${candles.length}개 일봉`);
      out[symbol] = { name, candles };
    }
    await new Promise((r) => setTimeout(r, 800)); // 요청 간격 (rate limit 예방)
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify({ generatedAt: new Date().toISOString(), symbols: out }, null, 1));
  console.log("=== 백필 완료: data/market-history.json ===");
}

// 직접 실행할 때만 백필을 돌린다.
// scripts/check-history.ts가 missingHistory()만 쓰려고 import하는데, 가드가 없으면
// 검사만 하려다 5년치 다운로드가 통째로 시작된다.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/backfill.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error("백필 실패:", e);
    process.exitCode = 1;
  });
}
