import type { Candle, Indicators } from "./types";

export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(NaN);
    } else if (i === period - 1) {
      out.push(prev);
    } else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

// Wilder 방식 RSI
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(closes: number[]): { macd: number; signal: number; hist: number; histPrev: number } {
  if (closes.length < 35) return { macd: NaN, signal: NaN, hist: NaN, histPrev: NaN };
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]).filter((v) => !isNaN(v));
  const signalLine = emaSeries(macdLine, 9);
  const m = macdLine[macdLine.length - 1];
  const s = signalLine[signalLine.length - 1];
  const mPrev = macdLine[macdLine.length - 2];
  const sPrev = signalLine[signalLine.length - 2];
  return { macd: m, signal: s, hist: m - s, histPrev: mPrev - sPrev };
}

export function bollinger(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return { upper: NaN, lower: NaN, percentB: NaN };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + mult * sd;
  const lower = mean - mult * sd;
  const last = closes[closes.length - 1];
  const percentB = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  return { upper, lower, percentB };
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  // Wilder smoothing
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    val = (val * (period - 1) + trs[i]) / period;
  }
  return val;
}

export function volumeZScore(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return NaN;
  const hist = volumes.slice(-(period + 1), -1);
  const mean = hist.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  if (sd === 0) return 0;
  return (volumes[volumes.length - 1] - mean) / sd;
}

// 가장 최근 완성된 일봉 직전 20일 평균 거래량 — volumeZScore와 동일한 기준 윈도우를 써서
// "지금 거래량이 평소 대비 얼마나 많은지"를 원시 수치로도 인용할 수 있게 한다.
export function averageVolume(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return NaN;
  const hist = volumes.slice(-(period + 1), -1);
  return hist.reduce((a, b) => a + b, 0) / period;
}

export function computeIndicators(candles: Candle[]): Indicators {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ma20Now = sma(closes, 20);
  const ma20Ago = sma(closes.slice(0, -5), 20);
  const boll = bollinger(closes);
  const m = macd(closes);
  const yearCandles = candles.slice(-252);
  return {
    ma5: sma(closes, 5),
    ma20: ma20Now,
    ma60: sma(closes, 60),
    ma20SlopePct: isNaN(ma20Ago) ? 0 : ((ma20Now - ma20Ago) / ma20Ago) * 100,
    rsi14: rsi(closes),
    macd: m.macd,
    macdSignal: m.signal,
    macdHist: m.hist,
    macdHistPrev: m.histPrev,
    bollingerUpper: boll.upper,
    bollingerLower: boll.lower,
    percentB: boll.percentB,
    atr14: atr(candles),
    volumeZ: volumeZScore(volumes),
    lastVolume: volumes[volumes.length - 1],
    avgVolume20: averageVolume(volumes),
    high52w: Math.max(...yearCandles.map((c) => c.high)),
    low52w: Math.min(...yearCandles.map((c) => c.low)),
  };
}
