// 시세 수집: 야후 파이낸스(기본) + 네이버 금융(국내주 폴백)
import type { Candle, FearGreedIndex, MacroSnapshot, Quote, StockTicker } from "./types";
import { STOCKS } from "./types";

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
  const price = r.meta.regularMarketPrice;
  const closes = (r.indicators.quote[0]?.close ?? []).filter((v): v is number => v != null);

  // 전일 종가 후보 2가지: (1) 야후 메타데이터, (2) 일봉 시계열의 마지막 이전 봉.
  // 정상 상황이면 둘이 거의 같아야 한다. 공휴일 처리 방식 차이 등으로 데이터가 어긋나면
  // 간혹 한쪽이 완전히 엉뚱한 값(예: "코스피 -12%")을 만들어낼 수 있어, 두 후보 중
  // "허용 변동폭 이내이면서 더 보수적인(변동폭이 더 작은)" 쪽을 신뢰한다.
  const metaPrevClose = r.meta.previousClose ?? r.meta.chartPreviousClose ?? null;
  const seriesPrevClose = closes.length >= 2 ? closes[closes.length - 2] : null;
  const candidates = [metaPrevClose, seriesPrevClose].filter((v): v is number => v != null && v > 0);
  const maxPct = maxPlausibleChangePct(symbol);

  let prevClose: number | null = null;
  let bestAbsPct = Infinity;
  for (const c of candidates) {
    const pct = Math.abs((price - c) / c) * 100;
    if (pct <= maxPct && pct < bestAbsPct) {
      prevClose = c;
      bestAbsPct = pct;
    }
  }
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
    time: new Date(r.meta.regularMarketTime * 1000).toISOString(),
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
    return {
      symbol: ticker,
      name: STOCKS[ticker].name,
      price,
      prevClose: price - change,
      change,
      changePct,
      currency: "KRW",
      time: new Date().toISOString(),
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
async function fetchNaverIntraday(ticker: StockTicker): Promise<RawIntradayCandle[]> {
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${ticker}&timeframe=minute&count=200&requestType=0`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const text = await res.text();
    const rows = [...text.matchAll(/data="([^"]+)"/g)].map((m) => m[1]);
    const out: RawIntradayCandle[] = [];
    for (const row of rows) {
      const parts = row.split("|");
      if (parts.length < 6) continue;
      const [ts, o, h, l, c, v] = parts;
      const open = Number(o);
      const high = Number(h);
      const low = Number(l);
      const close = Number(c);
      const volume = Number(v);
      if ([open, high, low, close, volume].some((n) => Number.isNaN(n))) continue;
      // ts 형식: YYYYMMDDHHmm (KST) — KST 기준이므로 UTC로 9시간 빼서 ISO 생성
      const m = ts.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
      if (!m) continue;
      const [, yy, mo, dd, hh, mi] = m;
      const kstMs = Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi));
      const utcMs = kstMs - 9 * 3600_000;
      out.push({ time: new Date(utcMs).toISOString(), open, high, low, close, volume });
    }
    return out.length >= 3 ? out : [];
  } catch {
    return [];
  }
}

// ---- 통합 진입점 ----

export async function getStockQuote(ticker: StockTicker): Promise<Quote | null> {
  // 네이버 실시간 시세(polling.finance.naver.com)는 국내 종목 한정으로 야후보다 지연이 훨씬 짧다
  // (야후는 KRX 데이터 라이선스 특성상 15~20분 이상 지연되는 경우가 흔함) — 국내 종목은
  // 네이버를 우선 시도하고, 실패할 때만(응답 오류·형식 이상 등) 야후로 폴백한다.
  // 미국 종목(테슬라 등)은 네이버에 데이터가 없으므로 애초에 시도하지 않고 야후로 바로 간다.
  if (STOCKS[ticker].market === "KR") {
    const n = await fetchNaverRealtime(ticker);
    if (n) return n;
  }
  const y = await fetchQuote(STOCKS[ticker].yahoo, STOCKS[ticker].name);
  return y ? { ...y, symbol: ticker } : null;
}

export async function getStockCandles(ticker: StockTicker): Promise<Candle[]> {
  const y = await fetchDailyCandles(STOCKS[ticker].yahoo, "2y");
  if (y.length > 100) return y;
  return fetchNaverDaily(ticker);
}

export async function getStockIntradayCandles(ticker: StockTicker): Promise<RawIntradayCandle[]> {
  const y = await fetchIntradayCandles(STOCKS[ticker].yahoo, "5d", "5m");
  if (y.length >= 3) return y;
  return fetchNaverIntraday(ticker);
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
  const [usdkrw, kospi, nasdaq, sox, nikkei, shanghai, vix, spFutures, nasdaqFutures, fearGreed] = await Promise.all([
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
  ]);
  return { usdkrw, kospi, nasdaq, sox, nikkei, shanghai, vix, spFutures, nasdaqFutures, fearGreed };
}
