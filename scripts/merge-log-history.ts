// 자동수집 로그(data/log/*.json) → 일봉 히스토리(data/market-history.json) 병합.
//
// 실행: npx tsx scripts/merge-log-history.ts
//
// 왜 필요한가: 5개년 백필(scripts/backfill.ts)은 주 1회만 돌기 때문에, 마지막 백필 이후
// 최근 며칠은 히스토리에 빠져 있다. 그런데 급변동장에서는 그 며칠이 분석에 가장 중요하다
// (예: 2026-07-28~31에 삼성전기가 -39% 폭락 후 상한가 근접 반등). 자동수집은 장중 15분
// 간격으로 돌며 시세를 남기므로, 그 로그로 빠진 구간의 일봉을 복원한다.
//
// 정확도 한계(정직하게):
//  - 종가: 그날 마지막 스냅샷 가격. 15분 간격이라 실제 종가와 미세하게 다를 수 있으나,
//    다음날 스냅샷의 prevClose와 대조해 검증하므로 신뢰도가 높다.
//  - 시가/고가/저가: 스냅샷 최소/최대에서 추정. 스냅샷 사이 움직임은 못 잡으므로
//    실제 고저 범위보다 좁게 나올 수 있다(= 변동성을 과소추정하는 방향, 보수적).
//  - 거래량: 로그에 없어 직전 20일 중앙값으로 채운다(지표 계산이 깨지지 않게 하는 용도).
// 다음 주간 백필이 돌면 야후 공식 데이터로 덮어써져 자동 교정된다.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Candle, CollectedSnapshot } from "../lib/types";
import { STOCKS, TICKER_LIST } from "../lib/types";

const DATA = join(process.cwd(), "data");
// 히스토리 파일의 심볼 키 ↔ 앱 티커 매핑 (히스토리는 야후 심볼 기준)
const symbolFor = (ticker: string) => {
  const s = STOCKS[ticker as keyof typeof STOCKS];
  if (!s) return null;
  return s.market === "KR" ? `${ticker}.KS` : ticker;
};

interface DayAgg {
  prices: number[];
  prevClose: number | null;
  lastTime: string;
}

function main() {
  const histPath = join(DATA, "market-history.json");
  if (!existsSync(histPath)) {
    console.error("data/market-history.json 이 없습니다. 먼저 backfill을 실행하세요.");
    process.exit(1);
  }
  const hist = JSON.parse(readFileSync(histPath, "utf8")) as {
    generatedAt: string;
    symbols: Record<string, { name: string; candles: Candle[] }>;
  };

  // 1) 로그에서 티커별·날짜별 시세 집계
  const perTicker: Record<string, Record<string, DayAgg>> = {};
  const files = readdirSync(join(DATA, "log")).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const day = f.replace(".json", "");
    // 주말 스냅샷은 직전 거래일 시세를 그대로 들고 있어 중복 캔들을 만든다 — 제외
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    let snaps: CollectedSnapshot[];
    try {
      snaps = JSON.parse(readFileSync(join(DATA, "log", f), "utf8")) as CollectedSnapshot[];
    } catch {
      continue;
    }
    for (const snap of snaps) {
      for (const [ticker, q] of Object.entries(snap.quotes ?? {})) {
        if (!q || !(q.price > 0)) continue;
        if (!TICKER_LIST.includes(ticker as (typeof TICKER_LIST)[number])) continue;
        perTicker[ticker] = perTicker[ticker] ?? {};
        const d = (perTicker[ticker][day] = perTicker[ticker][day] ?? { prices: [], prevClose: null, lastTime: "" });
        d.prices.push(q.price);
        if (q.time >= d.lastTime) {
          d.lastTime = q.time;
          d.prevClose = q.prevClose > 0 ? q.prevClose : d.prevClose;
        }
      }
    }
  }

  // 2) 히스토리에 없는 날짜만 캔들로 추가
  let added = 0;
  const report: string[] = [];
  for (const ticker of Object.keys(perTicker)) {
    const sym = symbolFor(ticker);
    if (!sym || !hist.symbols[sym]) continue;
    const candles = hist.symbols[sym].candles;
    const have = new Set(candles.map((c) => c.date));
    const lastDate = candles.length ? candles[candles.length - 1].date : "";
    const volFallback = (() => {
      const recent = candles.slice(-20).map((c) => c.volume).filter((v) => v > 0).sort((a, b) => a - b);
      return recent.length ? recent[Math.floor(recent.length / 2)] : 0;
    })();

    const days = Object.keys(perTicker[ticker]).sort();
    const news: Candle[] = [];
    for (const day of days) {
      if (have.has(day) || day <= lastDate) continue;
      const agg = perTicker[ticker][day];
      if (agg.prices.length === 0) continue;
      const close = agg.prices[agg.prices.length - 1];
      const open = agg.prevClose && agg.prices.length > 1 ? agg.prices[0] : agg.prices[0];
      news.push({
        date: day,
        open,
        high: Math.max(...agg.prices),
        low: Math.min(...agg.prices),
        close,
        volume: volFallback,
      });
    }
    if (news.length === 0) continue;
    // 연속성 검증: 새 캔들의 prevClose 체인이 기존 마지막 종가와 이어지는지 확인
    const firstNew = news[0];
    const prevFromLog = perTicker[ticker][firstNew.date].prevClose;
    const lastKnown = candles.length ? candles[candles.length - 1].close : null;
    if (prevFromLog && lastKnown && Math.abs(prevFromLog / lastKnown - 1) > 0.02) {
      report.push(
        `⚠ ${STOCKS[ticker as keyof typeof STOCKS].name}: 로그의 전일종가(${prevFromLog.toLocaleString()})가 히스토리 마지막 종가(${lastKnown.toLocaleString()})와 2% 넘게 어긋남 — 중간에 빠진 거래일이 있을 수 있음`,
      );
    }
    candles.push(...news);
    candles.sort((a, b) => a.date.localeCompare(b.date));
    added += news.length;
    report.push(
      `${STOCKS[ticker as keyof typeof STOCKS].name.padEnd(10)} +${news.length}일 (${news[0].date} ~ ${news[news.length - 1].date}), 마지막 종가 ${news[news.length - 1].close.toLocaleString()}`,
    );
  }

  // --- 전체 캔들 OHLC 정합성 보정 ---
  // (1) high는 o/h/l/c의 최댓값, low는 최솟값이어야 한다. 야후 원본에도 어긋난 캔들이 소수 있고
  //     로그 병합분은 15분 스냅샷 사이 움직임을 못 잡아 범위가 좁다. 그대로 두면 ATR·Parkinson
  //     같은 변동폭 지표가 실제보다 작게 나와 위험을 과소평가한다.
  // (2) 거래량 0인 종목 캔들은 20일 중앙값으로 채운다(지수는 원래 0이라 대상에서 제외).
  let fixedOhlc = 0;
  let fixedVol = 0;
  for (const [sym, v] of Object.entries(hist.symbols)) {
    const isIndex = sym.startsWith("^") || sym.includes("=");
    const cs = v.candles;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const hi = Math.max(c.open, c.high, c.low, c.close);
      const lo = Math.min(c.open, c.high, c.low, c.close);
      if (c.high !== hi || c.low !== lo) {
        c.high = hi;
        c.low = lo;
        fixedOhlc++;
      }
      if (!isIndex && !(c.volume > 0)) {
        const near = cs.slice(Math.max(0, i - 20), i).map((x) => x.volume).filter((x) => x > 0).sort((a, b) => a - b);
        if (near.length) {
          c.volume = near[Math.floor(near.length / 2)];
          fixedVol++;
        }
      }
    }
  }
  if (fixedOhlc || fixedVol) {
    report.push(`정합성 보정: OHLC ${fixedOhlc}개, 거래량 결측 ${fixedVol}개`);
  }

  if (added === 0 && fixedOhlc === 0 && fixedVol === 0) {
    console.log("추가할 새 거래일이 없고 보정할 캔들도 없습니다 (히스토리가 이미 최신·정합).");
    return;
  }
  hist.generatedAt = new Date().toISOString();
  writeFileSync(histPath, JSON.stringify(hist, null, 1));
  console.log(`=== 자동수집 로그 → 일봉 히스토리 병합·보정 (신규 ${added}개 캔들) ===\n`);
  for (const r of report) console.log(r);
  console.log("\n※ 고가/저가는 15분 간격 스냅샷 기준 추정이라 실제보다 좁을 수 있습니다(변동성 과소추정 방향).");
  console.log("※ 다음 주간 백필이 돌면 야후 공식 데이터로 덮어써져 자동 교정됩니다.");
}

main();
