// 시세 수집: 야후 파이낸스(기본) + 네이버 금융(국내주 폴백)
import type { Candle, MacroSnapshot, Quote, StockTicker } from "./types";
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

export async function fetchQuote(symbol: string, name?: string): Promise<Quote | null> {
  const json = await fetchYahooChart(symbol, "5d", "1d");
  const r = json?.chart.result?.[0];
  if (!r) return null;
  const price = r.meta.regularMarketPrice;
  // 마지막 일봉이 오늘이면 전일 종가는 그 이전 봉에서 가져온다
  const closes = (r.indicators.quote[0]?.close ?? []).filter((v): v is number => v != null);
  let prevClose = r.meta.previousClose ?? r.meta.chartPreviousClose;
  if (closes.length >= 2 && Math.abs(closes[closes.length - 1] - price) < 1e-6) {
    prevClose = closes[closes.length - 2];
  }
  return {
    symbol,
    name: name ?? INDEX_NAMES[symbol] ?? symbol,
    price,
    prevClose,
    change: price - prevClose,
    changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
    currency: r.meta.currency,
    time: new Date(r.meta.regularMarketTime * 1000).toISOString(),
  };
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
    const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json?.datas?.[0];
    if (!d) return null;
    const price = Number(String(d.closePrice).replace(/,/g, ""));
    const changePct = Number(String(d.fluctuationsRatio).replace(/,/g, ""));
    const change = Number(String(d.compareToPreviousClosePrice).replace(/,/g, ""));
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
    const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
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

// ---- 통합 진입점 ----

export async function getStockQuote(ticker: StockTicker): Promise<Quote | null> {
  const y = await fetchQuote(STOCKS[ticker].yahoo, STOCKS[ticker].name);
  if (y) return { ...y, symbol: ticker };
  return fetchNaverRealtime(ticker);
}

export async function getStockCandles(ticker: StockTicker): Promise<Candle[]> {
  const y = await fetchDailyCandles(STOCKS[ticker].yahoo, "2y");
  if (y.length > 100) return y;
  return fetchNaverDaily(ticker);
}

export async function getMacroSnapshot(): Promise<MacroSnapshot> {
  const [usdkrw, kospi, nasdaq, sox, nikkei, shanghai] = await Promise.all([
    fetchQuote("KRW=X"),
    fetchQuote("^KS11"),
    fetchQuote("^IXIC"),
    fetchQuote("^SOX"),
    fetchQuote("^N225"),
    fetchQuote("000001.SS"),
  ]);
  return { usdkrw, kospi, nasdaq, sox, nikkei, shanghai };
}
