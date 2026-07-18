// 매매 판단 엔진: 기술적 지표 + 매크로 + 뉴스 감성을 종합한 룰 기반 신호 생성.
// 원칙:
//  - 손실 제한이 최우선 (1회 매매 리스크 = 총자산의 1% 이내)
//  - 신규 진입은 복수 지표가 동시에 확인될 때만
//  - 물타기(하락 추매)는 원칙적으로 금지, 피라미딩(수익 중 추매)만 허용
//  - 손절가는 ATR 기반, 도달 시 무조건 실행 권고
import type {
  Candle,
  EngineSignal,
  Indicators,
  MacroSnapshot,
  NewsItem,
  Portfolio,
  StockTicker,
} from "./types";
import { STOCKS } from "./types";
import { computeIndicators } from "./indicators";

const MAX_POSITION_WEIGHT = 0.5; // 한 종목 최대 비중 (총자산 대비)
const ENTRY_FRACTION = 0.25; // 1회 매수 시 현금 대비 최대 비율
const RISK_PER_TRADE = 0.01; // 1회 매매 허용 손실 = 총자산의 1%

export function newsSentimentScore(news: NewsItem[], stockName: string): { score: number; notes: string[] } {
  let score = 0;
  const notes: string[] = [];
  for (const n of news) {
    const related =
      n.relatedTo.includes(stockName) ||
      n.relatedTo.includes("반도체") ||
      n.relatedTo.includes("매크로");
    if (!related) continue;
    const w = n.impact === "높음" ? 5 : n.impact === "중간" ? 3 : 1;
    if (n.sentiment === "긍정") score += w;
    else if (n.sentiment === "부정") {
      score -= w;
      if (n.impact === "높음") notes.push(`악재 주의: ${n.title}`);
    }
  }
  return { score: Math.max(-15, Math.min(15, score)), notes };
}

function macroScore(macro: MacroSnapshot): { score: number; notes: string[] } {
  let score = 0;
  const notes: string[] = [];
  if (macro.sox) {
    if (macro.sox.changePct >= 1.5) {
      score += 10;
      notes.push(`미 반도체지수(SOX) 강세 +${macro.sox.changePct.toFixed(1)}%`);
    } else if (macro.sox.changePct >= 0.3) score += 5;
    else if (macro.sox.changePct <= -1.5) {
      score -= 10;
      notes.push(`미 반도체지수(SOX) 급락 ${macro.sox.changePct.toFixed(1)}%`);
    } else if (macro.sox.changePct <= -0.3) score -= 5;
  }
  if (macro.nasdaq) {
    if (macro.nasdaq.changePct >= 1) score += 4;
    else if (macro.nasdaq.changePct <= -1) score -= 4;
  }
  if (macro.kospi) {
    if (macro.kospi.changePct >= 0.5) score += 3;
    else if (macro.kospi.changePct <= -0.5) score -= 3;
  }
  if (macro.usdkrw && Math.abs(macro.usdkrw.changePct) >= 0.7) {
    score -= 3;
    notes.push(`환율 변동성 확대(${macro.usdkrw.changePct > 0 ? "원화 약세" : "원화 강세"} ${Math.abs(macro.usdkrw.changePct).toFixed(1)}%) — 외국인 수급 유의`);
  }
  return { score, notes };
}

function technicalScore(ind: Indicators, price: number): { score: number; reasons: string[]; warnings: string[] } {
  let score = 50;
  const reasons: string[] = [];
  const warnings: string[] = [];

  // 추세
  if (price > ind.ma20) {
    score += 8;
    reasons.push("주가가 20일선 위 (단기 상승 추세)");
  } else {
    score -= 8;
    warnings.push("주가가 20일선 아래 (단기 추세 약세)");
  }
  if (ind.ma5 > ind.ma20) score += 5;
  else score -= 5;
  if (ind.ma20SlopePct > 0.5) {
    score += 5;
    reasons.push("20일선 기울기 상승 중");
  } else if (ind.ma20SlopePct < -0.5) score -= 5;

  // 모멘텀 (RSI)
  if (ind.rsi14 >= 45 && ind.rsi14 <= 65) {
    score += 6;
    reasons.push(`RSI ${ind.rsi14.toFixed(0)} — 과열 아닌 건전한 모멘텀`);
  } else if (ind.rsi14 < 30) {
    score += 4;
    reasons.push(`RSI ${ind.rsi14.toFixed(0)} — 과매도 구간 (반등 가능성)`);
  } else if (ind.rsi14 > 72) {
    score -= 10;
    warnings.push(`RSI ${ind.rsi14.toFixed(0)} — 단기 과열, 추격 매수 위험`);
  }

  // MACD
  if (ind.macdHist > 0 && ind.macdHist > ind.macdHistPrev) {
    score += 7;
    reasons.push("MACD 상승 전환 유지");
  } else if (ind.macdHist < 0 && ind.macdHist < ind.macdHistPrev) {
    score -= 7;
  }

  // 볼린저
  if (ind.percentB > 0.98) {
    score -= 5;
    warnings.push("볼린저 상단 돌파 — 변동성 확대 구간");
  } else if (ind.percentB < 0.05) {
    score += 3;
    reasons.push("볼린저 하단 근접 — 낙폭 과대");
  }

  // 거래량
  if (ind.volumeZ > 1) {
    if (price > ind.ma5) {
      score += 6;
      reasons.push("평균 대비 거래량 급증 + 상승 (매수세 유입)");
    } else {
      score -= 6;
      warnings.push("거래량 급증 + 하락 (매도세 강함)");
    }
  }

  // 52주 위치
  const range = ind.high52w - ind.low52w;
  if (range > 0) {
    const pos = (price - ind.low52w) / range;
    if (pos > 0.92) warnings.push("52주 신고가 부근 — 차익실현 매물 유의");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, warnings };
}

export function runEngine(params: {
  ticker: StockTicker;
  price: number;
  candles: Candle[];
  macro: MacroSnapshot;
  news: NewsItem[];
  portfolio: Portfolio;
}): EngineSignal {
  const { ticker, price, candles, macro, news, portfolio } = params;
  const name = STOCKS[ticker].name;
  const ind = computeIndicators(candles);

  const tech = technicalScore(ind, price);
  const mac = macroScore(macro);
  const sent = newsSentimentScore(news, name);

  let score = Math.max(0, Math.min(100, tech.score + mac.score + sent.score));
  const reasons = [...tech.reasons, ...mac.notes];
  const warnings = [...tech.warnings, ...sent.notes];

  const holding = portfolio.holdings.find((h) => h.ticker === ticker && h.qty > 0) ?? null;
  const totalHoldingValue = portfolio.holdings.reduce((a, h) => a + h.qty * price, 0);
  const totalAsset = portfolio.cash + totalHoldingValue;

  const atrStopDist = isNaN(ind.atr14) ? price * 0.03 : Math.max(ind.atr14 * 1.5, price * 0.02);

  let action: EngineSignal["action"] = "관망";
  let targetPrice: number | null = null;
  let stopPrice: number | null = null;
  let suggestedBudget: number | null = null;
  let suggestedQty: number | null = null;
  let pnlPct: number | null = null;

  if (holding) {
    pnlPct = ((price - holding.avgPrice) / holding.avgPrice) * 100;
    const entryStopDist = Math.max(holding.avgPrice * 0.03, atrStopDist);
    // 기본 손절선: 평단 - 리스크폭. 수익 중이면 트레일링 스탑으로 끌어올림
    stopPrice = Math.round(holding.avgPrice - entryStopDist);
    if (price > holding.avgPrice + entryStopDist) {
      stopPrice = Math.max(stopPrice, Math.round(price - ind.atr14 * 2));
      reasons.push("수익 구간 — 트레일링 스탑(고점 추적 손절선) 적용");
    }
    targetPrice = Math.round(holding.avgPrice + entryStopDist * 2); // 손익비 1:2

    if (price <= stopPrice) {
      action = "손절";
      warnings.unshift(`손절선(${stopPrice.toLocaleString()}원) 이탈 — 원칙대로 정리 후 재진입 기회를 기다리세요`);
    } else if (pnlPct <= -7) {
      action = "손절";
      warnings.unshift("손실 -7% 초과 — 단타 원칙상 즉시 정리 권고");
    } else if (score <= 32) {
      action = "전량매도";
      warnings.unshift("종합 신호 급격 악화 — 리스크 회피 우선");
    } else if (price >= targetPrice && score < 60) {
      action = "전량매도";
      reasons.unshift("목표가(손익비 1:2) 도달 + 모멘텀 둔화 — 수익 확정");
    } else if (price >= targetPrice) {
      action = "부분매도";
      reasons.unshift("목표가 도달 — 절반 수익 실현, 나머지는 트레일링 스탑으로 관리");
    } else if (ind.rsi14 > 75 && pnlPct > 3) {
      action = "부분매도";
      reasons.unshift("단기 과열 + 수익 구간 — 일부 차익실현 권고");
    } else if (
      score >= 70 &&
      pnlPct >= 3 &&
      (holding.qty * price) / totalAsset < MAX_POSITION_WEIGHT &&
      portfolio.cash > price
    ) {
      action = "추가매수";
      const budget = Math.min(portfolio.cash * ENTRY_FRACTION, (totalAsset * RISK_PER_TRADE * price) / atrStopDist);
      suggestedBudget = Math.floor(budget);
      suggestedQty = Math.max(1, Math.floor(budget / price));
      reasons.unshift("수익 중 + 신호 강세 — 피라미딩(불타기) 조건 충족");
    } else {
      action = "보유";
    }
  } else {
    // 미보유
    stopPrice = Math.round(price - atrStopDist);
    targetPrice = Math.round(price + atrStopDist * 2);
    if (score >= 68 && portfolio.cash > price) {
      action = "신규매수";
      const budget = Math.min(portfolio.cash * ENTRY_FRACTION, (totalAsset * RISK_PER_TRADE * price) / atrStopDist);
      suggestedBudget = Math.floor(budget);
      suggestedQty = Math.max(1, Math.floor(budget / price));
      reasons.unshift(`진입 신호 충족 (점수 ${score}) — 분할 매수 권장, 진입 즉시 손절가 설정`);
    } else if (score >= 58) {
      action = "관망";
      reasons.unshift("매수 근접 구간 — 추가 확인(거래량·해외지수) 후 진입 권장");
    } else {
      action = "관망";
    }
  }

  const confidence: EngineSignal["confidence"] =
    score >= 72 || score <= 28 ? "높음" : score >= 60 || score <= 40 ? "중간" : "낮음";

  return {
    ticker,
    name,
    action,
    score: Math.round(score),
    confidence,
    reasons,
    warnings,
    targetPrice,
    stopPrice,
    suggestedBudget,
    suggestedQty,
    pnlPct: pnlPct == null ? null : Math.round(pnlPct * 100) / 100,
    price,
    indicators: ind,
  };
}
