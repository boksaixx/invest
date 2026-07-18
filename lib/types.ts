// 공용 타입 정의

export interface Candle {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  change: number; // 등락 (원)
  changePct: number; // 등락률 (%)
  currency: string;
  time: string; // ISO
}

export interface MacroSnapshot {
  usdkrw: Quote | null;
  kospi: Quote | null;
  nasdaq: Quote | null;
  sox: Quote | null; // 필라델피아 반도체지수
  nikkei: Quote | null;
  shanghai: Quote | null;
}

export interface Indicators {
  ma5: number;
  ma20: number;
  ma60: number;
  ma20SlopePct: number; // 최근 5일간 MA20 기울기 (%)
  rsi14: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  macdHistPrev: number;
  bollingerUpper: number;
  bollingerLower: number;
  percentB: number; // 볼린저 %B (0~1)
  atr14: number;
  volumeZ: number; // 20일 거래량 z-score
  high52w: number;
  low52w: number;
}

export interface Holding {
  ticker: StockTicker;
  avgPrice: number; // 평균 매수가
  qty: number; // 보유 수량
}

export interface Portfolio {
  cash: number; // 보유 현금 (원)
  holdings: Holding[];
}

export type StockTicker = "005930" | "000660";

export type Action =
  | "신규매수"
  | "추가매수"
  | "보유"
  | "부분매도"
  | "전량매도"
  | "손절"
  | "관망";

export interface EngineSignal {
  ticker: StockTicker;
  name: string;
  action: Action;
  score: number; // 0~100 (높을수록 매수 우위)
  confidence: "높음" | "중간" | "낮음";
  reasons: string[];
  warnings: string[];
  targetPrice: number | null; // 목표가
  stopPrice: number | null; // 손절가
  suggestedBudget: number | null; // 신규/추가 매수 시 제안 금액 (원)
  suggestedQty: number | null; // 제안 수량
  pnlPct: number | null; // 보유 시 수익률 (%)
  price: number;
  indicators: Indicators;
}

export interface NewsItem {
  title: string;
  summary: string;
  sentiment: "긍정" | "부정" | "중립";
  impact: "높음" | "중간" | "낮음";
  relatedTo: string; // 삼성전자 | SK하이닉스 | 매크로 | 반도체업황 등
  source?: string;
  publishedAt?: string;
}

export interface AiAdvice {
  overall: {
    marketComment: string; // 오늘 시장 총평
    riskLevel: "높음" | "중간" | "낮음";
    headline: string;
  };
  stocks: {
    ticker: string;
    action: Action;
    confidence: "높음" | "중간" | "낮음";
    headline: string;
    rationale: string[];
    targetPrice: number | null;
    stopPrice: number | null;
    checklist: string[]; // 실행 전 확인사항
  }[];
  newsHighlights: string[];
  generatedAt: string;
}

export interface CollectedSnapshot {
  collectedAt: string; // ISO
  quotes: Record<string, Quote | null>;
  macro: MacroSnapshot;
  news: NewsItem[];
  signals: EngineSignal[] | null;
  aiSummary: string | null;
}

export const STOCKS: Record<StockTicker, { name: string; yahoo: string }> = {
  "005930": { name: "삼성전자", yahoo: "005930.KS" },
  "000660": { name: "SK하이닉스", yahoo: "000660.KS" },
};
