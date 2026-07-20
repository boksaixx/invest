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

// 스토캐스틱 슬로우(%K, %D) — RSI를 보완하는 단기 모멘텀 지표. RSI는 가격 변화의 평균 크기를,
// 스토캐스틱은 최근 N일 고저 레인지 내 종가 위치를 본다 — 레인지 장세에서 특히 RSI보다 민감하게 반응한다.
export function stochastic(
  candles: Candle[],
  period = 14,
  kSmooth = 3,
  dSmooth = 3,
): { k: number; d: number } {
  if (candles.length < period + kSmooth + dSmooth) return { k: NaN, d: NaN };
  const rawK: number[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const highest = Math.max(...window.map((c) => c.high));
    const lowest = Math.min(...window.map((c) => c.low));
    const close = candles[i].close;
    rawK.push(highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100);
  }
  const slowK: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    const slice = rawK.slice(i - kSmooth + 1, i + 1);
    slowK.push(slice.reduce((a, b) => a + b, 0) / kSmooth);
  }
  const d: number[] = [];
  for (let i = dSmooth - 1; i < slowK.length; i++) {
    const slice = slowK.slice(i - dSmooth + 1, i + 1);
    d.push(slice.reduce((a, b) => a + b, 0) / dSmooth);
  }
  return { k: slowK[slowK.length - 1] ?? NaN, d: d[d.length - 1] ?? NaN };
}

// RSI를 시계열 전체로 반환 — 다이버전스 탐지처럼 "과거 특정 시점의 RSI"가 필요한 경우에 쓴다.
// (rsi()는 최신값 하나만 반환) 알고리즘은 rsi()와 동일(Wilder 평활)해야 하므로 로직을 맞춰둔다.
export function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ADX(추세 강도) — 방향(+DI/-DI)이 아니라 "추세가 얼마나 강한지"만 본다. 25 이상이면 추세 장세
// (추세추종 전략이 유리), 20 미만이면 횡보 장세(저점매수/역추세 전략이 유리)로 흔히 해석한다.
// 이 구분으로 엔진이 "무조건 올라타기"만 하지 않고 장세에 맞게 전략 가중치를 조정할 수 있다.
function wilderSmoothSum(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0);
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = prev - prev / period + values[i];
    out.push(prev);
  }
  return out;
}

export function adx(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return NaN;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }
  const smoothedPlusDM = wilderSmoothSum(plusDM, period);
  const smoothedMinusDM = wilderSmoothSum(minusDM, period);
  const smoothedTR = wilderSmoothSum(tr, period);
  const n = Math.min(smoothedPlusDM.length, smoothedMinusDM.length, smoothedTR.length);
  const dx: number[] = [];
  for (let i = 0; i < n; i++) {
    const plusDI = smoothedTR[i] === 0 ? 0 : (100 * smoothedPlusDM[i]) / smoothedTR[i];
    const minusDI = smoothedTR[i] === 0 ? 0 : (100 * smoothedMinusDM[i]) / smoothedTR[i];
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }
  if (dx.length < period) return NaN;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
  }
  return adxVal;
}

// 최근 window*2+1일 구간에서 "가운데 날이 최솟값/최댓값"인 지점을 스윙 저점/고점으로 찾는다.
// 확정을 위해 앞뒤로 window일이 필요하므로, 가장 최근 window일은 스윙포인트로 잡히지 않는다
// (아직 미확정 — 표준적인 스윙포인트 탐지 방식).
function findSwingLows(closes: number[], window = 3): number[] {
  const idx: number[] = [];
  for (let i = window; i < closes.length - window; i++) {
    const slice = closes.slice(i - window, i + window + 1);
    if (closes[i] === Math.min(...slice)) idx.push(i);
  }
  return idx;
}
function findSwingHighs(closes: number[], window = 3): number[] {
  const idx: number[] = [];
  for (let i = window; i < closes.length - window; i++) {
    const slice = closes.slice(i - window, i + window + 1);
    if (closes[i] === Math.max(...slice)) idx.push(i);
  }
  return idx;
}

// RSI 다이버전스: 가격은 이전 저점보다 더 낮은데(하락 지속) RSI는 이전 저점보다 더 높으면
// (하락 모멘텀 약화) 강세 다이버전스 — 저점매수 진입의 고전적 확인 신호. 고점에서는 반대(약세
// 다이버전스)로 기존 보유자에게 "상승 모멘텀이 식고 있다"는 경고가 된다.
export function detectDivergence(
  closes: number[],
  rsiSer: number[],
  lookback = 40,
): { bullish: boolean; bearish: boolean } {
  const start = Math.max(0, closes.length - lookback);
  const recentCloses = closes.slice(start);
  const recentRsi = rsiSer.slice(start);
  const lows = findSwingLows(recentCloses, 3);
  const highs = findSwingHighs(recentCloses, 3);

  let bullish = false;
  if (lows.length >= 2) {
    const [l1, l2] = lows.slice(-2);
    if (!isNaN(recentRsi[l1]) && !isNaN(recentRsi[l2]) && recentCloses[l2] < recentCloses[l1] && recentRsi[l2] > recentRsi[l1]) {
      bullish = true;
    }
  }
  let bearish = false;
  if (highs.length >= 2) {
    const [h1, h2] = highs.slice(-2);
    if (!isNaN(recentRsi[h1]) && !isNaN(recentRsi[h2]) && recentCloses[h2] > recentCloses[h1] && recentRsi[h2] < recentRsi[h1]) {
      bearish = true;
    }
  }
  return { bullish, bearish };
}

// OBV(누적거래량) — 상승일 거래량은 더하고 하락일 거래량은 빼서 누적. 가격 추세와 OBV 추세가
// 같은 방향이면 그 추세가 실제 수급을 동반한 "건강한" 움직임이고, 엇갈리면(예: 가격은 오르는데
// OBV는 빠짐) 거래량 뒷받침 없는 "약한" 움직임 — 스마트머니의 조용한 매집/분산을 잡아내는 용도.
export function obvSeries(candles: Candle[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = out[i - 1];
    if (candles[i].close > candles[i - 1].close) out.push(prev + candles[i].volume);
    else if (candles[i].close < candles[i - 1].close) out.push(prev - candles[i].volume);
    else out.push(prev);
  }
  return out;
}

export function obvDiverges(candles: Candle[], window = 20): boolean {
  if (candles.length < window + 1) return false;
  const closes = candles.map((c) => c.close);
  const obv = obvSeries(candles);
  const n = closes.length;
  const priceRising = closes[n - 1] > closes[n - 1 - window];
  const obvRising = obv[n - 1] > obv[n - 1 - window];
  return priceRising !== obvRising;
}

// 망치형(해머) 캔들 — 몸통은 작고 아래꼬리가 길게(몸통의 2배 이상) 달린 캔들. 하락 도중 나타나면
// "저가권에서 매도세를 매수세가 흡수했다"는 전형적인 단기 반전 신호로 본다.
export function isHammer(c: Candle): boolean {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0 || body <= 0) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  return lowerWick >= body * 2 && upperWick <= body * 0.5 && body / range < 0.4;
}

// 해머 캔들 + 직전 하락 흐름(5거래일 전보다 낮음)을 함께 확인해야 "저가권 반전 시도"로서
// 의미가 있다 — 상승장에서 나오는 해머는 단순 눌림일 뿐 반전 신호로 보기 어렵다.
export function hammerReversalSignal(candles: Candle[]): boolean {
  if (candles.length < 6) return false;
  const last = candles[candles.length - 1];
  if (!isHammer(last)) return false;
  const priorClose = candles[candles.length - 6].close;
  return last.close < priorClose;
}

// 클래식 피벗 포인트 — 직전 거래일 고가/저가/종가만으로 계산하는 표준 단타 지지/저항 프레임워크.
// 별도 데이터 없이 순수 계산이라 항상 즉시 나오고, 데이트레이더들이 실제로 가장 흔히 참고하는 레벨이다.
export function pivotPoints(candles: Candle[]): { pp: number; r1: number; r2: number; s1: number; s2: number } {
  if (candles.length === 0) return { pp: NaN, r1: NaN, r2: NaN, s1: NaN, s2: NaN };
  const last = candles[candles.length - 1];
  const pp = (last.high + last.low + last.close) / 3;
  const range = last.high - last.low;
  return { pp, r1: 2 * pp - last.low, s1: 2 * pp - last.high, r2: pp + range, s2: pp - range };
}

export function computeIndicators(candles: Candle[]): Indicators {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ma20Now = sma(closes, 20);
  const ma20Ago = sma(closes.slice(0, -5), 20);
  const boll = bollinger(closes);
  const m = macd(closes);
  const stoch = stochastic(candles);
  const pivots = pivotPoints(candles);
  const yearCandles = candles.slice(-252);
  const rsiSer = rsiSeries(closes);
  const div = detectDivergence(closes, rsiSer);
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
    stochK: stoch.k,
    stochD: stoch.d,
    pivotPP: pivots.pp,
    pivotR1: pivots.r1,
    pivotS1: pivots.s1,
    pivotR2: pivots.r2,
    pivotS2: pivots.s2,
    adx14: adx(candles),
    bullishDivergence: div.bullish,
    bearishDivergence: div.bearish,
    obvDivergence: obvDiverges(candles),
    hammerReversal: hammerReversalSignal(candles),
  };
}
