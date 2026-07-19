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

export interface FearGreedIndex {
  value: number; // 0~100
  ratingKo: string; // 극단적공포 | 공포 | 중립 | 탐욕 | 극단적탐욕
  ratingRaw: string; // 원문 라벨 (extreme fear 등)
  source: string;
}

export interface MacroSnapshot {
  usdkrw: Quote | null;
  kospi: Quote | null;
  nasdaq: Quote | null;
  sox: Quote | null; // 필라델피아 반도체지수
  nikkei: Quote | null;
  shanghai: Quote | null;
  vix: Quote | null; // 변동성지수 (공포지수)
  spFutures: Quote | null; // S&P500 선물 — 미장 마감 후~한국장 개장 전 오버나이트 방향성 지표
  nasdaqFutures: Quote | null; // 나스닥100 선물
  fearGreed: FearGreedIndex | null; // CNN 공포탐욕지수 (수집 실패 시 null, 판단에서 선택적으로만 반영)
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

// 장중(인트라데이) 인사이트 — "오늘 지금" 판단의 핵심 데이터
export interface IntradayInsight {
  available: boolean; // 장중 데이터 수집 성공 여부
  sessionDate: string; // 기준 날짜 (YYYY-MM-DD, KST)
  isToday: boolean; // 오늘 데이터인지, 최근 거래일(휴장/장전) 데이터인지
  todayOpen: number;
  todayHigh: number;
  todayLow: number;
  current: number;
  vwap: number; // 거래량가중평균가 — 당일 매수/매도 세력의 평균 단가
  distanceFromVwapPct: number; // 현재가가 VWAP 대비 몇 % 위/아래인지
  gapPct: number; // 시가가 전일 종가 대비 갭 (%)
  gapType: "갭상승" | "갭하락" | "보합";
  rangePositionPct: number; // 당일 고가-저가 범위 내 현재가 위치 (0~100)
  openingRangeHigh: number | null; // 개장 첫 30분 고가
  openingRangeLow: number | null; // 개장 첫 30분 저가
  orbStatus: "상단돌파" | "하단이탈" | "레인지내" | "판단불가"; // 오프닝레인지 브레이크아웃 상태
  momentum: "강한상승" | "상승" | "중립" | "하락" | "강한하락"; // 최근 약 30분 캔들 방향성
}

export interface MarketPhaseInfo {
  phase: string; // 장전 | 장초반 | 장중 | 점심시간대 | 마감임박 | 동시호가 | 장마감 | 휴장(주말)
  kstTime: string; // HH:MM
  note: string;
}

export interface ScaledOrder {
  price: number;
  qty: number | null;
  note: string;
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

export type StockTicker = "005930" | "000660" | "042700" | "009150" | "000990";

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
  intraday: IntradayInsight | null;
  marketPhase: MarketPhaseInfo;
  entryTriggers: string[]; // 진입 조건 (지금 당장이 아니라 "이 조건이 충족되면 진입")
  invalidation: string | null; // 무효화 조건 — 발생 시 목표가/손절가와 무관하게 즉시 재검토
  scaledEntry: ScaledOrder[]; // 분할 매수 라인
  scaledExit: ScaledOrder[]; // 분할 매도(익절) 라인
  relativeStrengthNote: string | null; // 반도체 5종목 중 상대강도 순위 코멘트
  estimatedRoundTripCostWon: number | null; // 왕복 거래비용(증권거래세+수수료) 추정액 (원)
  backtest: BacktestStats | null; // 3개년 일봉 기준 과거 신호 통계 (참고용, 확정적 예측 아님)
  buyStrength: number; // 0~10, 미보유 시 "지금 얼마나 강하게 사야 하는지" (참고용으로 항상 계산)
  sellStrength: number | null; // 0~10, 보유 중일 때만 계산 — "지금 얼마나 강하게 팔아야 하는지"
  actionSummary: string; // 위 점수를 한 문장으로 요약 (초보자용 헤드라인)
}

// 3개년 일봉만으로 재현한 단순 백테스트 통계 (장중/뉴스/매크로는 과거 재현 불가하므로 제외).
// 룰 엔진의 technicalScore(일봉 기술적 점수)가 68점 이상이었던 과거 시점들을
// "진입 신호"로 보고, N거래일 후 종가 기준 수익률을 집계한 값이다.
export interface BacktestStats {
  periodStart: string;
  periodEnd: string;
  sampleSignals: number; // 표본으로 잡힌 과거 진입 신호 횟수
  winRate5d: number | null; // 5거래일 후 수익 마감 비율 (%)
  avgReturn5d: number | null; // 5거래일 후 평균 수익률 (%)
  winRate10d: number | null; // 10거래일 후 수익 마감 비율 (%)
  avgReturn10d: number | null; // 10거래일 후 평균 수익률 (%)
}

export interface RankedStock {
  ticker: StockTicker;
  name: string;
  changePct: number;
  rank: number;
}

export interface NewsItem {
  title: string;
  summary: string;
  sentiment: "긍정" | "부정" | "중립";
  impact: "높음" | "중간" | "낮음";
  relatedTo: string; // 삼성전자 | SK하이닉스 | 매크로 | 반도체업황 등
  source?: string;
  publishedAt?: string;
  isBreaking?: boolean; // 최근 몇 시간 내 발생한 속보성 뉴스인지
}

export interface AiAdvice {
  overall: {
    marketComment: string; // 오늘 시장 총평
    riskLevel: "높음" | "중간" | "낮음";
    headline: string;
    timeContext: string; // 지금 시간대(장초반/장중/마감임박 등)를 고려한 코멘트
  };
  stocks: {
    ticker: string;
    action: Action;
    confidence: "높음" | "중간" | "낮음";
    actionScore: number; // 0~10. 미보유 시 매수 강도, 보유 중이면 매도 강도 (사용자가 가장 먼저 보는 숫자)
    headline: string;
    rationale: string[];
    targetPrice: number | null;
    stopPrice: number | null;
    checklist: string[]; // 실행 전 확인사항
    entryTriggers: string[]; // 지금 당장이 아니라 "이 조건이 되면 진입"
    invalidation: string | null; // 이게 발생하면 목표가/손절가 무관 즉시 재검토
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
  "042700": { name: "한미반도체", yahoo: "042700.KS" },
  "009150": { name: "삼성전기", yahoo: "009150.KS" },
  "000990": { name: "DB하이텍", yahoo: "000990.KS" },
};

export const TICKER_LIST: StockTicker[] = ["005930", "000660", "042700", "009150", "000990"];
