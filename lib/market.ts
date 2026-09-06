// 시세 수집: 야후 파이낸스(기본) + 네이버 금융(국내주 폴백)
import type { Candle, FearGreedIndex, MacroSnapshot, Quote, StockTicker } from "./types";
import { STOCKS } from "./types";
import { getMarketPhase } from "./marketPhase";

/** KST 기준 오늘 날짜 (YYYY-MM-DD) */
export function kstToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 이 시세가 "오늘(KST) 세션"의 것인가.
 * 장전·휴일에는 마지막 체결이 전 거래일이라 quote.prevClose(=그 전날 종가)로 상한가·VI를 계산하면
 * 하루 어긋난다. 그때는 현재가(=전일 종가)를 기준가로 써야 한다 — sessionPrevClose 참조.
 */
export function isQuoteFromToday(q: Quote, now: Date = new Date()): boolean {
  return kstToday(new Date(q.time)) === kstToday(now);
}

/** 상한가·하한가·정적VI 계산용 "전일 종가" — 오늘 체결이 없으면 현재가가 곧 전일 종가다 */
export function sessionPrevClose(q: Quote, now: Date = new Date()): number {
  return isQuoteFromToday(q, now) ? q.prevClose : q.price;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const INDEX_NAMES: Record<string, string> = {
  "KRW=X": "원/달러 환율",
  "^KS11": "코스피",
  "^IXIC": "나스닥",
  "^SOX": "필라델피아 반도체",
  "^N225": "니케이225",
  "000001.SS": "상해종합",
  "^VIX": "변동성지수(VIX)",
  "ES=F": "S&P500 선물",
  "NQ=F": "나스닥100 선물",
  "CL=F": "WTI 원유",
};

interface YahooChart {
  chart: {
    result?: {
      meta: {
        regularMarketPrice: number;
        chartPreviousClose: number;
        previousClose?: number;
        currency: string;
        regularMarketTime: number;
        symbol: string;
      };
      timestamp?: number[];
      indicators: {
        quote: {
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }[];
      };
    }[];
    error?: unknown;
  };
}

async function fetchYahooChart(symbol: string, range: string, interval: string): Promise<YahooChart | null> {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as YahooChart;
      if (json.chart?.result?.length) return json;
    } catch {
      // 다음 호스트 시도
    }
  }
  return null;
}

// 지수/환율/VIX 등은 종류별로 "하루에 이 이상 움직이면 사실상 데이터 오류"로 볼 상한선이 다르다.
// VIX는 실제로 하루 수십%씩 급등락하는 게 정상이라 억지로 누르면 안 되고, 반대로 코스피 같은
// 지수는 역사상 최악의 날도 -9%대였으므로 그보다 훨씬 큰 값이 나오면 거의 확실히 데이터 오류다.
function maxPlausibleChangePct(symbol: string): number {
  if (symbol === "^VIX") return 100;
  if (symbol === "KRW=X") return 6;
  if (symbol.startsWith("^") || symbol.endsWith("=F") || symbol === "000001.SS") return 10;
  return 32; // 개별 종목 — 한국 상하한 30%에 여유를 둠
}

export async function fetchQuote(symbol: string, name?: string): Promise<Quote | null> {
  const json = await fetchYahooChart(symbol, "5d", "1d");
  const r = json?.chart.result?.[0];
  if (!r) return null;
  // 가격 유효성 검사 — 네이버 경로(fetchNaverRealtime)에는 있는데 여기만 빠져 있었다.
  // 야후가 장 시작 전이나 상장폐지·심볼 변경 시 regularMarketPrice를 null/0/문자열로 돌려주는 일이
  // 있고, 그 값이 그대로 엔진에 들어가면 손절가가 음수로 계산돼 화면에 뜬다(QA에서 재현).
  // 값을 못 믿겠으면 "시세 없음"으로 내려보내는 편이 틀린 가격을 보여주는 것보다 안전하다.
  const price = Number(r.meta.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) {
    console.warn(`[market] 유효하지 않은 현재가 — ${symbol}: ${r.meta.regularMarketPrice}`);
    return null;
  }
  const closes = (r.indicators.quote[0]?.close ?? []).filter((v): v is number => v != null && Number.isFinite(v));

  // 전일 종가 후보: (1) 야후 meta.previousClose(있을 때만), (2) 일봉 시계열의 마지막 이전 봉.
  //
  // 2026-09 감사에서 잡힌 버그: 예전에는 meta.chartPreviousClose도 후보에 넣고 "변동폭이 더 작은
  // 쪽"을 골랐다. 그런데 range=5d 요청의 chartPreviousClose는 "어제"가 아니라 "5일 구간 시작 전
  // 종가"라서, 코스피가 실제로 +1.64%인 날 -1.50%로 저장됐다(data/latest.json 2026-09-04).
  // 이 값이 macroScore를 통해 전 종목 점수에 들어갔다. 다중일 구간의 chartPreviousClose는 절대
  // "전일"이 아니므로 후보에서 뺀다. 허용 변동폭은 "고르는 기준"이 아니라 "버리는 기준"으로만 쓴다.
  const metaPrevClose = r.meta.previousClose ?? null;
  const seriesPrevClose = closes.length >= 2 ? closes[closes.length - 2] : null;
  const maxPct = maxPlausibleChangePct(symbol);
  const plausible = (c: number | null): c is number => c != null && c > 0 && Math.abs((price - c) / c) * 100 <= maxPct;

  let prevClose: number | null = null;
  if (plausible(seriesPrevClose)) prevClose = seriesPrevClose;
  else if (plausible(metaPrevClose)) prevClose = metaPrevClose;
  const candidates = [metaPrevClose, seriesPrevClose].filter((v): v is number => v != null && v > 0);
  // 그럴듯한 후보가 하나도 없으면(둘 다 비정상적으로 큰 변동) 데이터를 신뢰할 수 없다고 보고
  // 등락률 0%로 안전하게 처리한다 — 틀린 급등락을 그대로 보여주는 것보다 "변동 없음"이 실전 매매엔 덜 위험하다.
  if (prevClose == null) {
    if (candidates.length > 0) {
      console.warn(
        `[market] 비정상 등락률 감지 — ${symbol}: price=${price}, 후보=[${candidates.join(", ")}] 전부 허용치(±${maxPct}%) 초과 — 0%로 보정`,
      );
    }
    prevClose = price;
  }

  return {
    symbol,
    name: name ?? INDEX_NAMES[symbol] ?? symbol,
    price,
    prevClose,
    change: price - prevClose,
    changePct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
    currency: r.meta.currency,
    // 야후가 regularMarketTime을 빼먹으면 new Date(NaN) → toISOString()이 예외를 던져
    // 시세 전체가 날아간다. 시각을 모르면 "지금"으로 두되, 화면의 지연 표시가 과신되지 않도록
    // 현재 시각을 그대로 쓴다(지연 경고는 다른 신호로도 충분히 나온다).
    time: new Date(
      Number.isFinite(r.meta.regularMarketTime) ? r.meta.regularMarketTime * 1000 : Date.now(),
    ).toISOString(),
  };
}

export interface RawIntradayCandle {
  time: string; // ISO
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 장중 분봉 수집 (야후 파이낸스). range는 최근 며칠치를 요청할지(주말/휴장 대비 여유있게).
export async function fetchIntradayCandles(symbol: string, range = "5d", interval = "5m"): Promise<RawIntradayCandle[]> {
  const json = await fetchYahooChart(symbol, range, interval);
  const r = json?.chart.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators.quote[0];
  const out: RawIntradayCandle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: new Date(r.timestamp[i] * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: v ?? 0 });
  }
  return out;
}

export async function fetchDailyCandles(symbol: string, range = "2y"): Promise<Candle[]> {
  const json = await fetchYahooChart(symbol, range, "1d");
  const r = json?.chart.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators.quote[0];
  const out: Candle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({
      date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v ?? 0,
    });
  }
  return out;
}

// ---- 네이버 금융 폴백 (국내 종목 전용) ----

async function fetchNaverRealtime(ticker: StockTicker): Promise<Quote | null> {
  try {
    const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${ticker}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json?.datas?.[0];
    if (!d) return null;
    const price = Number(String(d.closePrice).replace(/,/g, ""));
    const changePct = Number(String(d.fluctuationsRatio).replace(/,/g, ""));
    const change = Number(String(d.compareToPreviousClosePrice).replace(/,/g, ""));
    if (!Number.isFinite(price) || !Number.isFinite(changePct) || !Number.isFinite(change) || price <= 0) return null;
    // 마지막 체결 시각 — 네이버는 localTradedAt("2026-09-04T15:30:00+09:00")을 준다.
    // 예전에는 new Date()를 넣어 주말·휴일에도 "방금 전 시세"로 표시됐고, 장전에는
    // prevClose(=그저께 종가)로 상한가·VI가 하루 어긋났다(sessionPrevClose로 보정).
    const traded = d.localTradedAt ? new Date(String(d.localTradedAt)) : null;
    return {
      symbol: ticker,
      name: STOCKS[ticker].name,
      price,
      prevClose: price - change,
      change,
      changePct,
      currency: "KRW",
      time: traded && Number.isFinite(traded.getTime()) ? traded.toISOString() : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function fetchNaverDaily(ticker: StockTicker, days = 600): Promise<Candle[]> {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const url = `https://api.finance.naver.com/siseJson.naver?symbol=${ticker}&requestType=1&startTime=${fmt(start)}&endTime=${fmt(end)}&timeframe=day`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const text = await res.text();
    // 응답: [['날짜','시가','고가','저가','종가','거래량','외국인소진율'], ['20240102', ...], ...]
    const rows = JSON.parse(text.replace(/'/g, '"')) as unknown[][];
    const out: Candle[] = [];
    for (const row of rows.slice(1)) {
      const [date, open, high, low, close, volume] = row as [string, number, number, number, number, number];
      if (typeof close !== "number") continue;
      const ds = String(date);
      out.push({
        date: `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`,
        open,
        high,
        low,
        close,
        volume,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// 네이버 분봉 폴백 (야후 장중 데이터 수집 실패 시에만 사용). 형식이 불안정할 수 있어
// 파싱 결과가 의심스러우면(캔들 3개 미만 등) 아예 버리고 "데이터 없음"으로 처리한다 —
// 실전 매매 판단에는 틀린 데이터보다 데이터 없음이 낫다.
export async function fetchNaverIntraday(ticker: StockTicker): Promise<RawIntradayCandle[]> {
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${ticker}&timeframe=minute&count=200&requestType=0`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const text = await res.text();
    const rows = [...text.matchAll(/data="([^"]+)"/g)].map((m) => m[1]);
    // 2026-09 감사에서 확인한 실제 응답: "202609041530|null|null|null|255500|14030754" —
    // 1분봉인데 시·고·저가 null, 종가와 "누적" 거래량만 온다. 예전 파서는 null을 NaN으로 읽어
    // 전 행을 버렸고(폴백이 한 번도 작동한 적 없음). 종가·누적거래량만으로 1분 시계열을 만들고
    // 5분봉으로 묶는다(시가=첫 종가, 고저=종가 최대·최소, 거래량=누적 차분).
    type Tick = { ms: number; close: number; cumVol: number; open?: number; high?: number; low?: number };
    const ticks: Tick[] = [];
    for (const row of rows) {
      const parts = row.split("|");
      if (parts.length < 6) continue;
      const [ts, o, h, l, c, v] = parts;
      const close = Number(c);
      const cumVol = Number(v);
      if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(cumVol)) continue;
      // ts 형식: YYYYMMDDHHmm (KST) — KST 기준이므로 UTC로 9시간 빼서 ISO 생성
      const m = ts.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
      if (!m) continue;
      const [, yy, mo, dd, hh, mi] = m;
      const kstMs = Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi));
      const tick: Tick = { ms: kstMs - 9 * 3600_000, close, cumVol };
      const open = Number(o);
      const high = Number(h);
      const low = Number(l);
      if ([open, high, low].every((n) => Number.isFinite(n) && n > 0)) Object.assign(tick, { open, high, low });
      ticks.push(tick);
    }
    ticks.sort((a, b) => a.ms - b.ms);
    const out: RawIntradayCandle[] = [];
    let prevCum: number | null = null;
    let prevDay = "";
    for (const t of ticks) {
      const day = new Date(t.ms).toISOString().slice(0, 10);
      if (day !== prevDay) prevCum = null; // 누적 거래량은 날짜마다 0에서 다시 시작
      prevDay = day;
      const vol = prevCum == null ? 0 : Math.max(0, t.cumVol - prevCum);
      prevCum = t.cumVol;
      const bucket = Math.floor(t.ms / (5 * 60_000)) * 5 * 60_000;
      const last = out[out.length - 1];
      if (last && new Date(last.time).getTime() === bucket) {
        last.high = Math.max(last.high, t.high ?? t.close);
        last.low = Math.min(last.low, t.low ?? t.close);
        last.close = t.close;
        last.volume += vol;
      } else {
        out.push({ time: new Date(bucket).toISOString(), open: t.open ?? t.close, high: t.high ?? t.close, low: t.low ?? t.close, close: t.close, volume: vol });
      }
    }
    return out.length >= 3 ? out : [];
  } catch {
    return [];
  }
}

// ---- 업비트 (가상자산 원화마켓, 키 없는 공개 API) ----
// 시세·5년 일봉·5분봉 전부 여기서 받는다. 일봉은 09:00 KST에 시작하고, 마지막 일봉은 항상 "진행 중"이다.

const UPBIT = "https://api.upbit.com/v1";

interface UpbitTicker {
  market: string;
  trade_price: number;
  prev_closing_price: number;
  signed_change_price: number;
  signed_change_rate: number;
  trade_timestamp: number;
}
interface UpbitCandle {
  candle_date_time_utc: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume: number;
  timestamp: number;
}

async function upbitGet<T>(path: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(`${UPBIT}${path}`, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchUpbitQuote(ticker: StockTicker): Promise<Quote | null> {
  const arr = await upbitGet<UpbitTicker[]>(`/ticker?markets=${STOCKS[ticker].yahoo}`);
  const d = arr?.[0];
  if (!d || !Number.isFinite(d.trade_price) || d.trade_price <= 0) return null;
  return {
    symbol: ticker,
    name: STOCKS[ticker].name,
    price: d.trade_price,
    prevClose: d.prev_closing_price, // 업비트 "전일"은 직전 09:00 KST 일봉의 종가
    change: d.signed_change_price,
    changePct: d.signed_change_rate * 100,
    currency: "KRW",
    time: new Date(d.trade_timestamp).toISOString(),
  };
}

/**
 * 업비트 일봉 — 한 번에 200개까지라 `to`로 거슬러 올라가며 이어 붙인다. days=1900이면 5년치 ≈ 10회 호출.
 * date는 candle_date_time_kst 의 날짜(09:00 시작 세션의 날짜). 오름차순으로 돌려준다.
 */
export async function fetchUpbitDaily(ticker: StockTicker, days = 400): Promise<Candle[]> {
  const market = STOCKS[ticker].yahoo;
  const out = new Map<string, Candle>();
  let to: string | null = null;
  let remaining = days;
  while (remaining > 0) {
    const count = Math.min(200, remaining);
    const toParam: string = to ? `&to=${encodeURIComponent(to)}` : "";
    const arr: UpbitCandle[] | null = await upbitGet<UpbitCandle[]>(`/candles/days?market=${market}&count=${count}${toParam}`, 10_000);
    if (!arr || arr.length === 0) break;
    for (const c of arr) {
      if (![c.opening_price, c.high_price, c.low_price, c.trade_price].every((v) => Number.isFinite(v) && v > 0)) continue;
      out.set(c.candle_date_time_kst.slice(0, 10), {
        date: c.candle_date_time_kst.slice(0, 10),
        open: c.opening_price,
        high: c.high_price,
        low: c.low_price,
        close: c.trade_price,
        volume: c.candle_acc_trade_volume ?? 0,
      });
    }
    remaining -= arr.length;
    if (arr.length < count) break;
    to = `${arr[arr.length - 1].candle_date_time_utc}Z`; // 가장 오래된 캔들 시각 이전으로
    await new Promise((r) => setTimeout(r, 150)); // 초당 10회 제한 배려
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** 업비트 5분봉 — 최근 200개(약 16시간). 세션(09:00 시작) 기준 VWAP·오프닝레인지 계산에 충분하다. */
export async function fetchUpbitIntraday(ticker: StockTicker, count = 200): Promise<RawIntradayCandle[]> {
  const arr = await upbitGet<UpbitCandle[]>(`/candles/minutes/5?market=${STOCKS[ticker].yahoo}&count=${count}`);
  if (!arr) return [];
  return arr
    .filter((c) => [c.opening_price, c.high_price, c.low_price, c.trade_price].every((v) => Number.isFinite(v) && v > 0))
    .map((c) => ({ time: `${c.candle_date_time_utc}Z`, open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price, volume: c.candle_acc_trade_volume ?? 0 }))
    .reverse();
}

// ---- 통합 진입점 ----

export async function getStockQuote(ticker: StockTicker): Promise<Quote | null> {
  if (STOCKS[ticker].market === "CRYPTO") {
    const u = await fetchUpbitQuote(ticker);
    if (u) return u;
    // 폴백: 야후 BTC-KRW 같은 원화 환산 심볼 (전일 기준이 UTC 00:00이라 등락률이 업비트와 다를 수 있다)
    const y = await fetchQuote(STOCKS[ticker].yahoo.replace(/^KRW-(\w+)$/, "$1-KRW"), STOCKS[ticker].name);
    return y ? { ...y, symbol: ticker } : null;
  }
  // 네이버 실시간 시세(polling.finance.naver.com)는 국내 종목 한정으로 야후보다 지연이 훨씬 짧다
  // (야후는 KRX 데이터 라이선스 특성상 15~20분 이상 지연되는 경우가 흔함) — 국내 종목은
  // 네이버를 우선 시도하고, 실패할 때만(응답 오류·형식 이상 등) 야후로 폴백한다.
  // 해외 종목은 네이버에 데이터가 없으므로 애초에 시도하지 않고 야후로 바로 간다
  // (현재 추적 종목은 전부 국내라 이 경로는 사실상 폴백 전용이다).
  if (STOCKS[ticker].market === "KR") {
    const n = await fetchNaverRealtime(ticker);
    if (n) return n;
  }
  const y = await fetchQuote(STOCKS[ticker].yahoo, STOCKS[ticker].name);
  return y ? { ...y, symbol: ticker } : null;
}

/**
 * 진행 중인 "오늘" 일봉을 뗀다.
 *
 * 2026-09 감사에서 확인: 야후 일봉은 장중에 오늘 봉(시가~현재가, 거래량은 지금까지 누적)을 포함한다.
 * 엔진은 마지막 봉을 "직전 완성 거래일"로 읽으므로, 오전에는 피벗 S1/R1이 오늘 자신의 부분 레인지로
 * 계산되고, 거래량 Z점수는 늘 -3대(거래량 급증 보너스가 오전엔 구조적으로 불가능), 변동성 추정(σ)은
 * 부분 봉 수익률과 작은 거래량 때문에 약 9% 과소평가됐다(10:09 σ 4.51% vs 16:20 4.97%, 09-04 로그).
 * 검증 스크립트는 전부 완성 봉으로 돌렸으므로 엔진도 완성 봉만 봐야 한다. "오늘"은 분봉(intraday)이 맡는다.
 */
export function dropInProgressCandle(candles: Candle[], now: Date = new Date(), market: "KR" | "US" | "CRYPTO" = "KR"): Candle[] {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  if (market === "CRYPTO") {
    // 업비트 일봉은 09:00 KST에 시작해 다음 09:00까지 진행 중이다 — 오늘 세션 날짜의 봉은 항상 미완성
    const sessionDay = new Date(now.getTime() + 9 * 3600_000 - 9 * 3600_000).toISOString().slice(0, 10);
    return last.date === sessionDay ? candles.slice(0, -1) : candles;
  }
  if (last.date !== kstToday(now)) return candles;
  const phase = getMarketPhase(now).phase;
  // 정규장 마감(15:30) 이후에만 오늘 봉이 완성된 것이다. 휴장일에는 오늘 날짜 봉이 있을 수 없으니 그대로 둔다.
  if (phase === "장마감" || phase.startsWith("휴장")) return candles;
  return candles.slice(0, -1);
}

export async function getStockCandles(ticker: StockTicker): Promise<Candle[]> {
  if (STOCKS[ticker].market === "CRYPTO") {
    const u = await fetchUpbitDaily(ticker, 400);
    if (u.length > 100) return dropInProgressCandle(u, new Date(), "CRYPTO");
    const y = await fetchDailyCandles(STOCKS[ticker].yahoo.replace(/^KRW-(\w+)$/, "$1-KRW"), "2y");
    return dropInProgressCandle(y, new Date(), "CRYPTO");
  }
  const y = await fetchDailyCandles(STOCKS[ticker].yahoo, "2y");
  if (y.length > 100) return dropInProgressCandle(y);
  return dropInProgressCandle(await fetchNaverDaily(ticker));
}

export async function getStockIntradayCandles(ticker: StockTicker): Promise<RawIntradayCandle[]> {
  if (STOCKS[ticker].market === "CRYPTO") {
    const u = await fetchUpbitIntraday(ticker);
    if (u.length >= 3) return u;
    return fetchIntradayCandles(STOCKS[ticker].yahoo.replace(/^KRW-(\w+)$/, "$1-KRW"), "5d", "5m");
  }
  // 국내 종목은 네이버 1분봉(→5분봉 재구성)을 우선한다 — 2026-09 실측: 야후 KRX 5분봉은 15:00에서 끝나
  // 마감 동시호가(15:20~15:30) 거래량이 빠지고 지연도 크다. 네이버는 15:30 마감 봉까지 온다
  // (검증: 2026-09-04 마지막 봉 15:30 KST, 거래량 1,533,513주 = 동시호가 체결분).
  if (STOCKS[ticker].market === "KR") {
    const n = await fetchNaverIntraday(ticker);
    if (n.length >= 3) return n;
  }
  const y = await fetchIntradayCandles(STOCKS[ticker].yahoo, "5d", "5m");
  if (y.length >= 3) return y;
  return STOCKS[ticker].market === "KR" ? [] : fetchNaverIntraday(ticker);
}

// CNN 공포탐욕지수 (비공식 데이터 엔드포인트, 문서화되지 않은 API이므로 실패 시 조용히 null 반환).
// 참고용 보조지표일 뿐 매매 판단의 핵심 근거로 단독 사용하지 않는다.
async function fetchFearGreedIndex(): Promise<FearGreedIndex | null> {
  try {
    const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
      headers: { "User-Agent": UA, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const score = Number(json?.fear_and_greed?.score);
    const rating = String(json?.fear_and_greed?.rating ?? "");
    if (!Number.isFinite(score) || score < 0 || score > 100) return null;
    const ratingMap: Record<string, string> = {
      "extreme fear": "극단적 공포",
      fear: "공포",
      neutral: "중립",
      greed: "탐욕",
      "extreme greed": "극단적 탐욕",
    };
    return {
      value: Math.round(score),
      ratingKo: ratingMap[rating.toLowerCase()] ?? rating,
      ratingRaw: rating,
      source: "CNN Fear & Greed Index (미국 시장 기준)",
    };
  } catch {
    return null;
  }
}

export async function getMacroSnapshot(): Promise<MacroSnapshot> {
  const [usdkrw, kospi, nasdaq, sox, nikkei, shanghai, vix, spFutures, nasdaqFutures, fearGreed, oil, us10y] = await Promise.all([
    fetchQuote("KRW=X"),
    fetchQuote("^KS11"),
    fetchQuote("^IXIC"),
    fetchQuote("^SOX"),
    fetchQuote("^N225"),
    fetchQuote("000001.SS"),
    fetchQuote("^VIX"),
    fetchQuote("ES=F"),
    fetchQuote("NQ=F"),
    fetchFearGreedIndex(),
    fetchQuote("CL=F"),
    fetchQuote("^TNX"), // 미 10년물 국채금리 — 실패해도 null로 두고 나머지는 정상 동작
  ]);
  return { usdkrw, kospi, nasdaq, sox, nikkei, shanghai, vix, spFutures, nasdaqFutures, fearGreed, oil, us10y };
}
