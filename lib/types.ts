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
  oil: Quote | null; // WTI 원유 선물(CL=F) — 유가 급변동은 반도체 제조원가·글로벌 리스크심리에 영향
  // 미 10년물 국채금리(^TNX) — 기술주·반도체주의 밸류에이션 할인율 리스크.
  // ★ 점수(macroScore)에는 반영하지 않는다. 자체 히스토리가 아직 없어 기여도를 실측하지 못했기 때문이며,
  //   검증 없이 점수에 넣지 않는 것이 이 엔진의 원칙이다(같은 이유로 VIX도 변동성 모델에서 제외됐다).
  //   지금은 사람과 Claude가 읽는 "맥락 정보"로만 쓰고, 데이터가 쌓이면 그때 검증 후 반영한다.
  us10y: Quote | null;
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
  lastVolume: number; // 가장 최근 완성된 일봉의 거래량 (원시 수치 — AI가 근거로 직접 인용할 수 있도록)
  avgVolume20: number; // 최근 20일 평균 거래량 (lastVolume 직전 20일 기준)
  high52w: number;
  low52w: number;
  stochK: number; // 스토캐스틱 슬로우 %K (14,3,3) — RSI 보완용 단기 모멘텀, 80+ 과매수 / 20- 과매도
  stochD: number; // 스토캐스틱 %D (%K의 3일 평균, 시그널선)
  pivotPP: number; // 클래식 피벗 포인트 (직전 거래일 고저종 기준)
  pivotR1: number; // 1차 저항선
  pivotS1: number; // 1차 지지선
  pivotR2: number; // 2차 저항선
  pivotS2: number; // 2차 지지선
  adx14: number; // 추세 강도(방향 무관) — 25+ 추세장(추세추종 유리), 20- 횡보장(저점매수/역추세 유리)
  bullishDivergence: boolean; // RSI 강세 다이버전스: 가격은 더 낮은 저점, RSI는 더 높은 저점 (하락 모멘텀 약화 = 저점매수 확인 신호)
  bearishDivergence: boolean; // RSI 약세 다이버전스: 가격은 더 높은 고점, RSI는 더 낮은 고점 (상승 모멘텀 약화 = 보유자 경고 신호)
  obvDivergence: boolean; // 최근 20일 가격 추세와 OBV(누적거래량) 추세가 엇갈림 — 거래량 뒷받침 없는 "약한" 움직임
  hammerReversal: boolean; // 최근 하락 흐름 중 해머형 캔들 발생 — 저가권 매도세 흡수(단기 반전 시도) 신호
  volatilityRatio: number; // 최근(atr14) 변동폭 ÷ 장기(120일) 평소 변동폭. 1.0=평소 수준, 1.6 이상이면 "변동성 급확대" 국면으로 취급
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
  cash: number; // 보유 현금 (원) — 국내(KRW) 종목 매수용
  cashUSD: number; // 보유 달러현금 ($) — 미국(USD) 종목 매수용. 구버전 저장 데이터엔 없을 수 있어 항상 optional 취급하듯 0 기본값으로 다뤄야 함
  holdings: Holding[];
}

export type StockTicker =
  // 반도체 5종목
  | "005930"
  | "000660"
  | "042700"
  | "009150"
  | "000990"
  // 비반도체 5종목 — 반도체 블록과 다른 동인을 가진 업종만 골랐다 (아래 SECTOR_NOTE 참고)
  | "012450"
  | "005380"
  | "105560"
  | "068270"
  | "030200";

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
  // 자동 감시주문(HTS/MTS 예약) 지침. 확인 시간이 불규칙한 사용자를 위한 것으로,
  // "무조건 걸어라"가 아니라 실측 근거에 따라 조건부로 제시한다
  // (scripts/validate-watch-orders.ts: 하루 이상 못 보면 최악 -34%→-20%로 잘리지만,
  //  당일 안에 다시 볼 수 있으면 스톱이 스쳐 털리는 손해가 더 크다)
  watchOrderNote: string | null;
  relativeStrengthNote: string | null; // 반도체 5종목 중 상대강도 순위 코멘트
  estimatedRoundTripCostWon: number | null; // 왕복 거래비용(증권거래세+수수료) 추정액 (원)
  backtest: BacktestStats | null; // 5개년 일봉 기준 과거 신호 통계 (참고용, 확정적 예측 아님)
  buyStrength: number; // 0~10, 미보유 시 "지금 얼마나 강하게 사야 하는지" (참고용으로 항상 계산)
  sellStrength: number | null; // 0~10, 보유 중일 때만 계산 — "지금 얼마나 강하게 팔아야 하는지"
  actionSummary: string; // 위 점수를 한 문장으로 요약 (초보자용 헤드라인)
  verdict: string; // 전문가가 쉽게 풀어 말하듯 한 문장 판정 + 구체적 근거(추세선/거래량/환율 등). AI 없이도 항상 엔진이 계산 (정합성 보장)
  macroScore: number; // 매크로(환율·SOX·나스닥·코스피·선물·VIX) 전체 시장 영향도 점수. 양수=우호적, 음수=비우호적 — 개별 종목 점수에 이미 가산/감산되어 있는 값을 그대로 노출 (같은 시점 5종목 모두 동일)
  disclosures: DartFiling[]; // 최근 DART 공시 (DART_API_KEY 미설정 시 항상 빈 배열)
  suggestedEntryPrice: number | null; // "얼마에 사야 하는지" 대표 진입가. 미보유 시 신규매수 진입가, 보유 중이면서 action이 "추가매수"(피라미딩)일 때도 채워짐. 그 외 보유 중(매도 판단/단순 보유)은 매수 진입 개념이 없으므로 null
  entryPriceBasis: string | null; // 위 진입가의 구체적 근거 (예: "VWAP 상향 돌파 확인 시")
  investorFlow: InvestorFlowDay[]; // 최근 일별 외국인/기관 순매수 (KRX 연동 실패 시 항상 빈 배열)
  volForecast: VolForecast | null; // 내일 하루 예상 변동폭 추정 (lib/volatility.ts, 5개년 실데이터 검증)
  // 예상 경로(팬 차트용) — 조회 시점부터 마감까지 + D+1/D+2 확률 구간.
  // 검증: D+1/D+2/D+3의 90% 구간 실제 적중률 88.3~89.4% (scripts/validate-forecast-path.ts)
  forecastPath: ForecastPathData | null;
  // "오늘 오를 확률" — 국면별 실측 상승률과 "기저율과 구분되는가" 판정.
  // 방향 예측 모델은 3번 시도해 3번 다 기저율을 못 넘었으므로(lib/upRate.ts 주석 참고)
  // 확률을 만들어내지 않고 과거 실측 비율만 그대로 보여준다.
  upRate: UpRateSummary | null;
}

export interface UpRateSummary {
  regime: string;
  upRatePct: number;
  sampleN: number;
  overallPct: number;
  distinguishable: boolean;
  headline: string;
}

// 예상 경로 데이터 (lib/forecastPath.ts 가 계산). UI 차트 전용이라 Claude에는 보내지 않는다
// — 파생 데이터라 토큰을 쓸 이유가 없고, Claude는 이미 σ와 국면 통계를 받는다.
export interface ForecastPathData {
  available: boolean;
  currentPrice: number;
  asOfLabel: string;
  points: {
    label: string;
    minutesAhead: number;
    median: number;
    p25: number;
    p75: number;
    p05: number;
    p95: number;
    isDayBoundary: boolean;
    // 아래 orderLevels의 매수·매도 지정가에 "이 시각까지 한 번이라도 닿을" 누적 확률(%).
    // 시간이 갈수록 올라가므로 "몇 시쯤 체결을 기대할 수 있나"를 읽을 수 있다.
    // 방향 예측이 아니라 도달 가능성이다 — 방향 예측은 검증에서 실패해 쓰지 않는다
    // (scripts/validate-analog.ts: 적중률 47~50%로 기준선 미달, 따라가면 평균 손실).
    buyFillProbPct: number;
    sellFillProbPct: number;
  }[];
  intradayRemainingPct: number;
  note: string;
  // 바로 주문에 쓸 수 있는 지정가 후보. 확률은 5년 실측표(data/touch-stats.json) 기준.
  orderLevels: {
    buyPrice: number; // 눌림목 매수 지정가 후보
    buyProbPct: number; // 마감(또는 다음 거래일)까지 여기에 닿을 확률
    sellPrice: number; // 반등 매도 지정가 후보
    sellProbPct: number;
    horizonLabel: string; // 이 확률이 적용되는 기간 ("오늘 마감까지" 등)
  } | null;
}

// 시장 레짐 — 엔진이 그날 장세를 스스로 판별해 "오늘의 작전"을 바꾼다.
// (기존 일반/천재 모드 토글을 대체 — 모드를 사람이 고르는 게 아니라 장세가 정한다)
export type MarketRegime = "폭락장" | "급등과열" | "변동성확대" | "보통";

// 오늘의 작전에 담기는 개별 트레이드 지시.
// kind별 근거 (모두 5개년 실데이터 검증, scripts/validate-modes.ts 로 재현):
//  - 눌림목매수: σ비례 지정가 매수(-0.6σ 진입/+1.0σ 익절/-0.8σ 손절) — 4개 구간 모두 플러스
//  - 폭락반등매수: 당일 -7%↓ 폭락 종목을 마감 동시호가 소액 매수 → 익일 종가 청산.
//    실측 익일 평균 +1.4%(최근 급변동장 +2.1%), 승률 64~65%. 단 13.6% 확률로 연속 폭락이
//    있어 총자산 10% 이내 소액 전제. 익절/손절 변형은 검증에서 오히려 열위라 쓰지 않는다.
//  - 급등익절: 당일 +12%↑ 급등 보유 종목 — 익일 시가 투매 대신 전일종가 +3% 지정가 분할 매도.
//    실측 익일 고가가 +3% 도달 64%, 고가 평균 +5.4% (갭하락 출발도 42%라 전량 홀드는 금물).
export interface TodayTrade {
  kind: "눌림목매수" | "폭락반등매수" | "급등익절";
  ticker: StockTicker;
  name: string;
  currency: "KRW" | "USD";
  currentPrice: number;
  entryPrice: number | null; // 매수 계열: 지정가(눌림목) 또는 동시호가 참고가(폭락반등)
  targetPrice: number | null;
  stopPrice: number | null;
  sellLimitPrice: number | null; // 급등익절: 내일 걸어둘 매도 지정가
  sigmaDailyPct: number; // 변동성 추정치 (참고)
  suggestedQty: number | null;
  suggestedBudget: number | null;
  headline: string; // "마감 동시호가 소액 분할 매수" 처럼 무엇을 하라는지 한 줄
  rationale: string; // 왜 — 실측 통계 인용 포함
  cautions: string[];
}

// 보유 대 트레이딩 우열 — "지금 이 종목은 들고 있는 게 나았나, 사고파는 게 나았나"를
// 최근 120거래일 실적으로 분해해 보여준다. 예측이 아니라 사실 공시다.
//
// 왜 필요한가: 최근 6개월 삼성전자는 전체 +71.3% 중 오버나이트 갭이 +71.1%, 장중(시가→종가)은
// +0.1%였다. 즉 수익이 전부 밤사이에 발생했고, 매일 종가에 청산하는 단타 규칙은 그 수익에
// 구조적으로 접근할 수 없다. 실제로 같은 구간 단순 보유 +74% vs 플레이북 매매 -13%였다.
// 엔진이 이 사실을 숨기고 트레이딩만 권하면 사용자 돈에 해가 되므로 항상 함께 노출한다.
export interface HoldEdge {
  available: boolean;
  overnightPct: number; // 최근 120일 오버나이트 갭 누적 수익률 (%)
  intradayPct: number; // 최근 120일 장중(시가→종가) 누적 수익률 (%)
  totalPct: number; // 최근 120일 전체 수익률 (%)
  verdict: "보유우위" | "장중우위" | "혼재";
  note: string; // 사람이 읽는 한 줄 요약
}

export interface TodayPlan {
  regime: MarketRegime;
  regimeNote: string; // 왜 이 레짐으로 판정했는지 (예: "간밤 SOX -5.2% 폭락")
  trades: TodayTrade[]; // 최대 2개 — 없으면 "오늘은 없음"이 정직한 답
  holderGuide: string[]; // 보유자 행동 지침 (레짐별로 다름, 실측 근거 포함)
  marketNote: string;
  skippedNote: string | null;
  holdEdge: HoldEdge | null; // 보유 vs 트레이딩 우열 (대표 종목 기준)
  // 국면별 조건부 전망 — "지금과 같은 상태였던 과거 시점들"의 향후 수익률 분포.
  // 여러 장세를 뭉갠 평균 대신 조건부 분포를 쓰는 이유는 lib/scenario.ts 상단 주석 참고.
  scenarios: { name: string; label: string; note: string; lowConfidence: boolean }[];
}

// 변동성 추정 결과 — 상세 설명과 검증 근거는 lib/volatility.ts 상단 주석 참고.
export interface VolForecast {
  available: boolean;
  sigmaDailyPct: number; // 내일 1일 표준편차 추정 (%)
  annualizedPct: number; // 연율 환산 (%)
  range90: { lowPct: number; highPct: number }; // 90% 확률 등락 구간 (경험분위수 기반, 비대칭 가능)
  range98: { lowPct: number; highPct: number }; // 98% 확률 등락 구간 (꼬리위험)
  regime: "평온" | "보통" | "높음" | "극단";
  regimePercentile: number; // 과거 대비 현재 변동성 분위 (0~100)
  regimeRatio: number; // 현재 σ ÷ 과거 중앙값 σ
  skew: "상방" | "하방" | "대칭"; // 어느 쪽 꼬리가 더 두꺼운가 (상방=상한가 위험/기회)
  drivers: string[]; // 변동성을 밀어올린 요인
  // 표준화잔차 분위수 원값 — sigma를 곱하기 전 값. 조회 시점부터 마감까지처럼
  // "하루보다 짧은/긴" 구간으로 구간폭을 다시 계산할 때 쓴다.
  zQuantiles: { q05: number; q25: number; q75: number; q95: number };
}

// 5개년 일봉만으로 재현한 단순 백테스트 통계 (장중/뉴스/매크로는 과거 재현 불가하므로 제외).
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

// 5종목 + 매크로를 종합한 "오늘의 매수 매력도" 마스터 요약 — 개별 종목 판단과 별개로
// 화면 최상단에서 "오늘 전체적으로 살만한 날인가"를 한눈에 보여준다. AI 없이 엔진이 항상 계산.
export interface MasterScore {
  attractivenessPct: number; // 0~100, 5종목 평균 점수 기반 "매수 매력도"
  label: string; // "매수 우위" | "중립/관망" | "방어적(매도 우위)"
  tone: "buy" | "neutral" | "sell";
  headline: string; // 오늘의 종합 추천 행동 한 문장
  buyCount: number; // 매수 신호권(점수 68+) 종목 수
  sellCount: number; // 매도/경계 신호권(점수 32 이하) 종목 수
  strongestTicker: StockTicker | null;
  strongestName: string | null;
}

// DART(전자공시시스템) 공시 — 기업이 법적 의무로 직접 올리는 원천 정보라 뉴스보다 신뢰도가 높고 빠르다.
// DART_API_KEY 미설정 시 항상 빈 배열(선택 기능, 없어도 나머지 파이프라인은 정상 동작).
export interface DartFiling {
  title: string; // 공시 제목 (예: "자기주식취득결정")
  date: string; // 접수일자 YYYYMMDD
  reporterName: string; // 제출인
  url: string; // DART 원문 링크
  sentiment: "긍정" | "부정" | "중립"; // 제목 키워드 기반 단순 분류 (본문 분석 아님 — 참고용, 최종 해석은 AI가 함)
}

// KRX(한국거래소) 공개 데이터 기준, 전일까지 확정된 종목별 일별 외국인/기관 순매수(주).
// 실시간 체결 기준 수급이 아니라 EOD(장 마감 후 확정) 데이터 — 증권사 API 인증 없이 얻을 수
// 있는 가장 신뢰도 높은 공개 소스. KRX 접근이 실패하면 항상 빈 배열(나머지 파이프라인엔 무영향).
export interface InvestorFlowDay {
  date: string; // YYYY-MM-DD
  foreignNet: number; // 외국인 순매수(주) — 양수=순매수, 음수=순매도
  institutionNet: number; // 기관합계 순매수(주)
  pensionNet?: number; // 연기금 순매수(주) — KRX 상세(투자자별) 응답에서만 채워짐. 연기금은 장기 자금이라 순매수가 이어지면 하방 지지 신호로 해석
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

// 분석 버튼을 누를 때마다 새로 생성되는 종합 인사이트 리포트 — 여러 지표/분석 결과를
// 하나의 짧은 리포트로 엮어서 "지금 이 순간" 기준으로 왜 이런 판단인지 설명한다.
export interface InsightReport {
  marketRegime: string; // 오늘 장의 성격(추세장/횡보장 ADX 진단) + 매크로(환율·VIX·공포탐욕지수·선물) 배경 종합
  technicalSynthesis: string; // 5종목 전반의 기술적 지표(RSI/MACD/볼린저/스토캐스틱/피벗/다이버전스/해머/OBV) 흐름 종합
  flowAndSentiment: string; // 외국인/기관 수급 + 최신 뉴스·공시 심리 종합
  keyRisks: string; // 지금 반드시 조심해야 할 리스크 (변동성, 섹터집중도, 과열구간 등)
  actionPlan: string; // 5종목 중 지금 어떤 순서로/무엇을 봐야 하는지 실행 우선순위 한 문단
}

export interface AiAdvice {
  overall: {
    marketComment: string; // 오늘 시장 총평
    riskLevel: "높음" | "중간" | "낮음";
    headline: string;
    timeContext: string; // 지금 시간대(장초반/장중/마감임박 등)를 고려한 코멘트
  };
  insightReport: InsightReport;
  stocks: {
    ticker: string;
    action: Action;
    confidence: "높음" | "중간" | "낮음";
    actionScore: number; // 0~10. 미보유 시 매수 강도, 보유 중이면 매도 강도 (사용자가 가장 먼저 보는 숫자)
    timeHorizon: "당일" | "수일내(스윙)"; // 지금 액션이 겨냥하는 투자 시계열 — 당일 중 트리거 충족 예상인지, 며칠에 걸친 스윙 성격인지
    headline: string;
    rationale: string[];
    entryPrice: number | null; // 미보유 시 "얼마에 사야 하는지" 매수 진입가 (보유 중이면 null). rationale에 이 가격의 구체적 근거를 반드시 포함할 것
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
  masterScore: MasterScore | null;
}

// sector: "반도체" 종목에만 반도체 전용 통계(국면별 분포·도달확률 보정표·SOX 전이)를 적용한다.
// 그 통계들은 전부 국내 반도체 5종목으로 만든 것이라 다른 업종에 그대로 쓰면 근거 없는 숫자가 된다.
export const STOCKS: Record<
  StockTicker,
  { name: string; yahoo: string; market: "KR" | "US"; currency: "KRW" | "USD"; sector: string; driver: string }
> = {
  "005930": { name: "삼성전자", yahoo: "005930.KS", market: "KR", currency: "KRW", sector: "반도체", driver: "메모리 업황·SOX" },
  "000660": { name: "SK하이닉스", yahoo: "000660.KS", market: "KR", currency: "KRW", sector: "반도체", driver: "HBM·메모리 업황" },
  "042700": { name: "한미반도체", yahoo: "042700.KS", market: "KR", currency: "KRW", sector: "반도체", driver: "HBM 장비 수주" },
  "009150": { name: "삼성전기", yahoo: "009150.KS", market: "KR", currency: "KRW", sector: "반도체", driver: "MLCC·전장 부품" },
  "000990": { name: "DB하이텍", yahoo: "000990.KS", market: "KR", currency: "KRW", sector: "반도체", driver: "파운드리 가동률" },
  // ↓ 비반도체 — 반도체가 무너지는 날에 같이 무너지지 않을 동인을 기준으로 선정
  "012450": { name: "한화에어로스페이스", yahoo: "012450.KS", market: "KR", currency: "KRW", sector: "방산", driver: "지정학 긴장·수출 수주" },
  "005380": { name: "현대차", yahoo: "005380.KS", market: "KR", currency: "KRW", sector: "자동차", driver: "글로벌 판매·소비 경기" },
  "105560": { name: "KB금융", yahoo: "105560.KS", market: "KR", currency: "KRW", sector: "금융", driver: "금리·예대마진" },
  "068270": { name: "셀트리온", yahoo: "068270.KS", market: "KR", currency: "KRW", sector: "바이오", driver: "임상·허가·약가" },
  "030200": { name: "KT", yahoo: "030200.KS", market: "KR", currency: "KRW", sector: "통신", driver: "요금규제·배당(경기 방어)" },
};

/** 반도체 전용 통계를 적용해도 되는 종목인지 */
export const isSemiconductor = (t: StockTicker) => STOCKS[t].sector === "반도체";

export const TICKER_LIST: StockTicker[] = [
  "005930",
  "000660",
  "042700",
  "009150",
  "000990",
  "012450",
  "005380",
  "105560",
  "068270",
  "030200",
];

// 국내(KRX)/미국(나스닥 등) 종목 구분 — DART 공시·KRX 수급처럼 한국 시장 전용 데이터 소스를
// 미국 종목에는 아예 시도하지 않도록 걸러내거나, 시장별로 다른 로직(개장시간·통화)을 적용할 때 사용.
export const KR_TICKERS: StockTicker[] = TICKER_LIST.filter((t) => STOCKS[t].market === "KR");
export const US_TICKERS: StockTicker[] = TICKER_LIST.filter((t) => STOCKS[t].market === "US");
