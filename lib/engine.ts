// 매매 판단 엔진: 일봉 기술적 지표 + 장중(인트라데이) 데이터 + 매크로 + 뉴스 감성을 종합한
// 단기(단타) 트레이딩 신호 생성.
//
// 원칙:
//  - 손실 제한이 최우선 (1회 매매 리스크 = 총자산의 1% 이내)
//  - 신규 진입은 복수 지표(일봉 추세 + 장중 모멘텀 + 수급/뉴스)가 동시에 확인될 때만
//  - 물타기(하락 추매)는 원칙적으로 금지, 피라미딩(수익 중 추매)만 허용
//  - 손절가는 ATR 기반, 도달 시 무조건 실행 권고
//  - 단타는 "지금 사라/팔아라"만으로는 부족하다 — 진입 트리거(조건), 분할 매매,
//    무효화 조건(목표가/손절가와 별개로 논리 자체가 깨지는 지점)까지 함께 제시한다.
import type {
  Action,
  BacktestStats,
  Candle,
  DartFiling,
  EngineSignal,
  Indicators,
  IntradayInsight,
  InvestorFlowDay,
  MacroSnapshot,
  MarketPhaseInfo,
  MasterScore,
  NewsItem,
  Portfolio,
  RankedStock,
  ScaledOrder,
  StockTicker,
} from "./types";
import { STOCKS } from "./types";
import { computeIndicators } from "./indicators";

const MAX_POSITION_WEIGHT = 0.5; // 한 종목 최대 비중 (총자산 대비)
const ENTRY_FRACTION = 0.25; // 1회 매수 시 현금 대비 최대 비율
const RISK_PER_TRADE = 0.01; // 1회 매매 허용 손실 = 총자산의 1%
const ROUND_TRIP_COST_PCT = 0.0025; // 왕복 거래비용 추정치 (매도 시 증권거래세 약 0.18% + 매수·매도 수수료 각 약 0.015~0.03%)

export function newsSentimentScore(news: NewsItem[], stockName: string): { score: number; notes: string[] } {
  let score = 0;
  const notes: string[] = [];
  for (const n of news) {
    const related =
      n.relatedTo.includes(stockName) ||
      n.relatedTo.includes("반도체") ||
      n.relatedTo.includes("매크로") ||
      n.relatedTo.includes("파생시장");
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

// DART 전자공시는 기업이 법적 의무로 직접 올리는 원천 정보라 뉴스보다 신뢰도가 높다 —
// 최근 것부터 최대 2건만 반영해 과중복을 막고, 뉴스(최대 5점)에 준하는 가중치를 준다.
// 제목 키워드 기반 단순 분류일 뿐(본문 분석 아님)이므로 "중립"(내용 확인 필요)도 근거로 남긴다.
function disclosureScore(filings: DartFiling[] | undefined): { score: number; notes: string[]; warnings: string[] } {
  const notes: string[] = [];
  const warnings: string[] = [];
  if (!filings || filings.length === 0) return { score: 0, notes, warnings };
  let score = 0;
  for (const f of filings.slice(0, 2)) {
    if (f.sentiment === "긍정") {
      score += 4;
      notes.push(`공시 호재: ${f.title} (${f.date})`);
    } else if (f.sentiment === "부정") {
      score -= 4;
      warnings.push(`공시 주의: ${f.title} (${f.date}) — 내용 확인 필요`);
    } else {
      notes.push(`공시: ${f.title} (${f.date}) — 내용 확인 필요`);
    }
  }
  return { score: Math.max(-8, Math.min(8, score)), notes, warnings };
}

// 전일까지의 외국인+기관 순매수(KRX 공개 데이터)를 반영한다. 종목마다 유동성이 크게 달라
// 절대 주수로는 비교가 안 되므로, 해당 종목의 20일 평균거래량 대비 비율로 정규화해서 점수화한다.
function investorFlowScore(
  flows: InvestorFlowDay[] | undefined,
  avgVolume20: number,
): { score: number; notes: string[]; warnings: string[] } {
  const notes: string[] = [];
  const warnings: string[] = [];
  if (!flows || flows.length === 0 || isNaN(avgVolume20) || avgVolume20 <= 0) return { score: 0, notes, warnings };
  const latest = flows[flows.length - 1]; // 가장 최근(전일) 확정 데이터
  const combined = latest.foreignNet + latest.institutionNet;
  const pctOfAvgVol = (combined / avgVolume20) * 100;
  let score = 0;
  if (pctOfAvgVol > 3) {
    score = Math.max(-8, Math.min(8, Math.round(pctOfAvgVol / 2)));
    notes.push(
      `전일(${latest.date}) 외국인+기관 순매수 ${combined.toLocaleString()}주(20일평균거래량 대비 +${pctOfAvgVol.toFixed(1)}%) — 수급 우호적`,
    );
  } else if (pctOfAvgVol < -3) {
    score = Math.max(-8, Math.min(8, Math.round(pctOfAvgVol / 2)));
    warnings.push(
      `전일(${latest.date}) 외국인+기관 순매도 ${Math.abs(combined).toLocaleString()}주(20일평균거래량 대비 ${pctOfAvgVol.toFixed(1)}%) — 수급 이탈 주의`,
    );
  }
  return { score, notes, warnings };
}

function macroScore(macro: MacroSnapshot, marketPhase: MarketPhaseInfo): { score: number; notes: string[]; warnings: string[] } {
  let score = 0;
  const notes: string[] = [];
  const warnings: string[] = [];
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

  // 미국 지수 선물 — 장전/장초반에는 밤사이 형성된 가장 신선한 방향성 지표라 가중치를 더 준다
  const isPreOrEarlyMarket = marketPhase.phase === "장전" || marketPhase.phase === "장초반";
  const futuresWeight = isPreOrEarlyMarket ? 1.5 : 0.6;
  if (macro.nasdaqFutures) {
    if (macro.nasdaqFutures.changePct >= 0.7) {
      score += 6 * futuresWeight;
      notes.push(`나스닥100 선물 +${macro.nasdaqFutures.changePct.toFixed(2)}% — 개장 전 우호적 신호`);
    } else if (macro.nasdaqFutures.changePct <= -0.7) {
      score -= 6 * futuresWeight;
      warnings.push(`나스닥100 선물 ${macro.nasdaqFutures.changePct.toFixed(2)}% — 개장 전 부정적 신호`);
    }
  }
  if (macro.spFutures && Math.abs(macro.spFutures.changePct) >= 0.7) {
    score += macro.spFutures.changePct > 0 ? 3 * futuresWeight : -3 * futuresWeight;
  }

  // VIX(변동성지수) — 시장 전체의 공포 수준. 높을수록 리스크오프 국면.
  if (macro.vix) {
    if (macro.vix.price >= 30) {
      score -= 8;
      warnings.push(`VIX ${macro.vix.price.toFixed(1)} (30 이상, 시장 전반 공포 확산) — 단타 포지션 축소 권장`);
    } else if (macro.vix.price >= 25) {
      score -= 4;
      warnings.push(`VIX ${macro.vix.price.toFixed(1)} (경계 구간) — 변동성 확대 유의`);
    } else if (macro.vix.price <= 14) {
      notes.push(`VIX ${macro.vix.price.toFixed(1)} (안정 구간)`);
    }
  }

  // 공포탐욕지수 — 방향성 점수에는 반영하지 않고(단타에서 극단값의 방향 예측력은 낮음),
  // 극단값일 때 변동성 경고만 제공한다.
  if (macro.fearGreed) {
    if (macro.fearGreed.value <= 25) {
      warnings.push(`공포탐욕지수 ${macro.fearGreed.value} (${macro.fearGreed.ratingKo}) — 투매성 변동성 구간, 손절 원칙 더 엄격히 적용`);
    } else if (macro.fearGreed.value >= 75) {
      warnings.push(`공포탐욕지수 ${macro.fearGreed.value} (${macro.fearGreed.ratingKo}) — 과열 구간, 추격매수 시 되돌림 리스크 유의`);
    }
  }

  return { score, notes, warnings };
}

// 기술적 점수를 "추세추종"(trend) / "역추세·저점매수"(reversion) / "레짐 무관 리스크 신호"(neutral)
// 세 갈래로 나눠 합산한다. 추세추종만 있으면 "오를 때만 올라타는" 편향이 생기므로, ADX(추세 강도)로
// 지금이 추세장인지 횡보장인지 판단해 두 갈래의 가중치를 반대로 조정한다 — 추세장이면 추세추종을,
// 횡보장이면 저점매수/되돌림을 더 신뢰한다. 과열/거래량 급변 같은 리스크 신호는 장세와 무관하게
// 항상 같은 가중치를 유지한다(어느 장세든 위험은 위험이므로).
export function technicalScore(ind: Indicators, price: number): { score: number; reasons: string[]; warnings: string[] } {
  let trendScore = 0;
  let reversionScore = 0;
  let neutralScore = 0;
  const reasons: string[] = [];
  const warnings: string[] = [];

  // 추세추종 신호
  if (price > ind.ma20) {
    trendScore += 8;
    reasons.push("주가가 20일선 위 (단기 상승 추세)");
  } else {
    trendScore -= 8;
    warnings.push("주가가 20일선 아래 (단기 추세 약세)");
  }
  if (ind.ma5 > ind.ma20) trendScore += 5;
  else trendScore -= 5;
  if (ind.ma20SlopePct > 0.5) {
    trendScore += 5;
    reasons.push("20일선 기울기 상승 중");
  } else if (ind.ma20SlopePct < -0.5) trendScore -= 5;

  // 모멘텀(RSI) — 과열/건전 판정은 장세와 무관한 리스크 신호(neutral), 과매도 반등 기대는 저점매수(reversion)
  if (ind.rsi14 >= 45 && ind.rsi14 <= 65) {
    neutralScore += 6;
    reasons.push(`RSI ${ind.rsi14.toFixed(0)} — 과열 아닌 건전한 모멘텀`);
  } else if (ind.rsi14 < 30) {
    reversionScore += 4;
    reasons.push(`RSI ${ind.rsi14.toFixed(0)} — 과매도 구간 (반등 가능성)`);
  } else if (ind.rsi14 > 72) {
    neutralScore -= 10;
    warnings.push(`RSI ${ind.rsi14.toFixed(0)} — 단기 과열, 추격 매수 위험`);
  }

  // RSI 다이버전스 — 가격 저점/고점과 RSI 저점/고점이 엇갈리는 고신뢰 반전 신호.
  // "떨어질 때 심리"를 가장 직접적으로 잡아내는 저점매수 확인 지표라 reversion 중 가중치가 가장 크다.
  if (ind.bullishDivergence) {
    reversionScore += 10;
    reasons.push("RSI 강세 다이버전스 — 가격은 이전 저점보다 낮은데 RSI는 더 높음 (하락 모멘텀 약화, 저점매수 확인 신호)");
  }
  if (ind.bearishDivergence) {
    reversionScore -= 8;
    warnings.push("RSI 약세 다이버전스 — 가격은 이전 고점보다 높은데 RSI는 더 낮음 (상승 모멘텀 약화, 되돌림 유의)");
  }

  // 캔들패턴(해머) — 하락 흐름 중 저가권 매도세 흡수 신호. 다이버전스와 함께 나오면 더 신뢰도 높음.
  if (ind.hammerReversal) {
    reversionScore += 6;
    reasons.push("해머형 캔들 — 하락 흐름 중 저가권에서 매도세를 매수세가 흡수 (단기 반전 시도 신호)");
  }

  // OBV(누적거래량) 다이버전스 — 가격 추세와 거래량 추세가 엇갈리면(예: 오르는데 매집이 안 됨)
  // 그 추세가 거래량 뒷받침 없는 "약한" 움직임이라는 경고. 방향과 무관한 리스크 신호로 취급.
  if (ind.obvDivergence) {
    neutralScore -= 3;
    warnings.push("OBV(누적거래량) 다이버전스 — 최근 가격 추세가 거래량 뒷받침 없이 약하게 진행 중일 수 있음");
  }

  // 스토캐스틱(%K/%D) — 과매수 중첩 경고는 neutral, 과매도 반등은 reversion, 일반 모멘텀 확인은 trend
  if (!isNaN(ind.stochK) && !isNaN(ind.stochD)) {
    if (ind.stochK > 80 && ind.stochD > 80) {
      neutralScore -= 4;
      warnings.push(`스토캐스틱 %K ${ind.stochK.toFixed(0)} — 과매수 구간, RSI와 과열 신호 중첩`);
    } else if (ind.stochK < 20 && ind.stochK > ind.stochD) {
      reversionScore += 4;
      reasons.push(`스토캐스틱 %K ${ind.stochK.toFixed(0)} — 과매도 구간에서 %D 상향 돌파 (단기 반등 신호)`);
    } else if (ind.stochK > ind.stochD && ind.stochK < 80) {
      trendScore += 2;
      reasons.push("스토캐스틱 %K가 %D 위 — 단기 모멘텀 양호");
    }
  }

  // MACD
  if (ind.macdHist > 0 && ind.macdHist > ind.macdHistPrev) {
    trendScore += 7;
    reasons.push("MACD 상승 전환 유지");
  } else if (ind.macdHist < 0 && ind.macdHist < ind.macdHistPrev) {
    trendScore -= 7;
  }

  // 볼린저 — 상단 돌파는 neutral 리스크, 하단 근접(낙폭과대)은 reversion
  if (ind.percentB > 0.98) {
    neutralScore -= 5;
    warnings.push("볼린저 상단 돌파 — 변동성 확대 구간");
  } else if (ind.percentB < 0.05) {
    reversionScore += 3;
    reasons.push("볼린저 하단 근접 — 낙폭 과대");
  }

  // 거래량
  if (ind.volumeZ > 1) {
    if (price > ind.ma5) {
      neutralScore += 6;
      reasons.push("평균 대비 거래량 급증 + 상승 (매수세 유입)");
    } else {
      neutralScore -= 6;
      warnings.push("거래량 급증 + 하락 (매도세 강함)");
    }
  }

  // 52주 위치
  const range = ind.high52w - ind.low52w;
  if (range > 0) {
    const pos = (price - ind.low52w) / range;
    if (pos > 0.92) warnings.push("52주 신고가 부근 — 차익실현 매물 유의");
  }

  // 피벗 포인트(직전 거래일 고저종 기준 지지/저항) — S1 근접은 저점매수 후보라 reversion에 소폭 반영,
  // R1 근접은 이미 볼린저/52주 레인지로 과열 위험을 다루고 있어 정보성 문구만 추가한다.
  if (!isNaN(ind.pivotR1) && !isNaN(ind.pivotS1) && price > 0) {
    const distToR1Pct = ((ind.pivotR1 - price) / price) * 100;
    const distToS1Pct = ((price - ind.pivotS1) / price) * 100;
    if (distToR1Pct >= 0 && distToR1Pct < 1.2) {
      warnings.push(`피벗 저항선 R1(${Math.round(ind.pivotR1).toLocaleString()}원) 근접 — 돌파 실패 시 되돌림 유의`);
    } else if (distToS1Pct >= 0 && distToS1Pct < 1.2) {
      reversionScore += 2;
      reasons.push(`피벗 지지선 S1(${Math.round(ind.pivotS1).toLocaleString()}원) 부근 — 지지 확인되면 반등 매수 후보`);
    }
  }

  // ADX 기반 레짐 인식 — 추세가 강하면(25+) 추세추종을 우선하고 저점매수는 신중히(떨어지는 칼날
  // 위험), 추세가 약하고 횡보 중이면(20 미만) 반대로 저점매수/되돌림 신호를 더 신뢰한다.
  let trendWeight = 1;
  let reversionWeight = 1;
  if (!isNaN(ind.adx14)) {
    if (ind.adx14 >= 25) {
      trendWeight = 1.25;
      reversionWeight = 0.7;
      reasons.push(`추세 강도(ADX ${ind.adx14.toFixed(0)}) 높음 — 추세추종 신호 우선, 역추세 저점매수는 신중히`);
    } else if (ind.adx14 < 20) {
      trendWeight = 0.7;
      reversionWeight = 1.3;
      reasons.push(`추세 강도(ADX ${ind.adx14.toFixed(0)}) 낮음(횡보 장세) — 저점매수·되돌림 신호에 더 무게`);
    }
  }

  const score = 50 + trendScore * trendWeight + reversionScore * reversionWeight + neutralScore;
  return { score: Math.max(0, Math.min(100, score)), reasons, warnings };
}

// 단타의 핵심: 일봉만으로는 "오늘 지금" 사야 할지 알 수 없다.
// VWAP·갭·오프닝레인지·당일 모멘텀을 점수화한다.
function intradayScore(id: IntradayInsight | null): { score: number; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!id || !id.available) {
    warnings.push("장중(분봉) 데이터를 가져오지 못해 일봉 지표만으로 판단했습니다 — 단타 신뢰도가 낮으니 보수적으로 접근하세요");
    return { score: 0, reasons, warnings };
  }
  if (!id.isToday) {
    warnings.push(`장중 데이터가 오늘 것이 아닙니다(기준일: ${id.sessionDate}) — 휴장 중이거나 개장 전일 수 있습니다`);
  }

  let score = 0;

  // VWAP 위/아래
  if (id.distanceFromVwapPct > 0.15) {
    score += 8;
    reasons.push(`VWAP(${Math.round(id.vwap).toLocaleString()}원) 위 +${id.distanceFromVwapPct.toFixed(2)}% — 당일 매수세 우위`);
  } else if (id.distanceFromVwapPct < -0.15) {
    score -= 8;
    warnings.push(`VWAP(${Math.round(id.vwap).toLocaleString()}원) 아래 ${id.distanceFromVwapPct.toFixed(2)}% — 당일 매도세 우위`);
  }

  // 갭 방향 + 갭 유지/실패 여부
  if (id.gapType === "갭상승") {
    if (id.current >= id.todayOpen) {
      score += 6;
      reasons.push(`갭상승(+${id.gapPct.toFixed(2)}%) 출발 후 시가 지지 — 상승 갭 유지 중`);
    } else {
      score -= 6;
      warnings.push(`갭상승(+${id.gapPct.toFixed(2)}%) 출발했지만 시가 아래로 밀림 — 갭 메우기(fade) 진행, 상승 실패 신호`);
    }
  } else if (id.gapType === "갭하락") {
    if (id.current <= id.todayOpen) {
      score -= 6;
      warnings.push(`갭하락(${id.gapPct.toFixed(2)}%) 출발 후 반등 없이 약세 지속`);
    } else {
      score += 4;
      reasons.push(`갭하락(${id.gapPct.toFixed(2)}%) 출발했지만 시가 위로 반등 — 낙폭과대 반발매수 유입`);
    }
  }

  // 오프닝레인지 브레이크아웃
  if (id.orbStatus === "상단돌파") {
    score += 7;
    reasons.push(`오프닝레인지 상단(${id.openingRangeHigh ? Math.round(id.openingRangeHigh).toLocaleString() : "-"}원) 돌파 — 상승 전환 시그널`);
  } else if (id.orbStatus === "하단이탈") {
    score -= 7;
    warnings.push(`오프닝레인지 하단(${id.openingRangeLow ? Math.round(id.openingRangeLow).toLocaleString() : "-"}원) 이탈 — 하락 전환 시그널`);
  }

  // 당일 모멘텀 (최근 약 30분)
  if (id.momentum === "강한상승") {
    score += 6;
    reasons.push("최근 30분 캔들 대부분 양봉 — 강한 단기 상승 모멘텀");
  } else if (id.momentum === "상승") score += 3;
  else if (id.momentum === "강한하락") {
    score -= 6;
    warnings.push("최근 30분 캔들 대부분 음봉 — 강한 단기 하락 모멘텀");
  } else if (id.momentum === "하락") score -= 3;

  // 당일 레인지 내 위치 (과열/과매도, 일봉 RSI와 별개로 "오늘" 기준)
  if (id.rangePositionPct >= 95) warnings.push("당일 고가권 — 단기 눌림 유의, 추격 매수 자제");
  else if (id.rangePositionPct <= 5) reasons.push("당일 저가권 — 단기 반등 시도 가능 구간");

  return { score, reasons, warnings };
}

// 미보유 종목의 "매수 진입가"를 명확한 근거와 함께 하나의 숫자로 제시한다.
// 목표가·손절가는 이미 확정 숫자로 보여주면서 정작 "얼마에 사야 하는지"가 트리거 문장 속에
// 묻혀 있던 문제를 보완 — 신규매수 신호면 현재가(즉시 진입), 관망(매수 근접) 상태면 가장
// 우선순위 높은 진입 트리거의 가격 레벨을 대표 진입가로 노출한다.
function computeSuggestedEntryPrice(
  action: Action,
  price: number,
  intraday: IntradayInsight | null,
  ind: Indicators,
): { price: number; basis: string } | null {
  if (action === "신규매수") {
    return { price: Math.round(price), basis: "현재가 기준 즉시 진입 (분할매수 1차 라인 참고)" };
  }
  if (action === "관망") {
    if (intraday?.available) {
      return {
        price: Math.round(intraday.vwap),
        basis: `VWAP(${Math.round(intraday.vwap).toLocaleString()}원) 상향 돌파 + 거래량 증가 확인 시 진입`,
      };
    }
    return { price: Math.round(ind.ma20), basis: `20일선(${Math.round(ind.ma20).toLocaleString()}원) 회복 확인 시 진입 검토 (장중 데이터 미확보)` };
  }
  return null;
}

function buildEntryTriggers(id: IntradayInsight | null, ind: Indicators): string[] {
  const triggers: string[] = [];
  if (!id || !id.available) {
    triggers.push(`20일선(${Math.round(ind.ma20).toLocaleString()}원) 회복 확인 후 진입 검토 (장중 데이터 미확보로 보수적 접근)`);
    return triggers;
  }
  triggers.push(`VWAP(${Math.round(id.vwap).toLocaleString()}원) 상향 돌파 + 거래량 증가 동반 시 1차 진입`);
  if (id.openingRangeHigh) {
    triggers.push(`오프닝레인지 상단(${Math.round(id.openingRangeHigh).toLocaleString()}원) 돌파 후 되돌림(눌림목)에서 진입`);
  }
  if (id.gapType === "갭하락") {
    triggers.push(`당일 저가(${Math.round(id.todayLow).toLocaleString()}원) 지지 확인(이탈 없이 반등) 시 반발매수 진입`);
  }
  return triggers;
}

function buildInvalidation(id: IntradayInsight | null, macro: MacroSnapshot): string | null {
  const parts: string[] = [];
  if (id?.available && id.openingRangeLow) {
    parts.push(`오프닝레인지 하단(${Math.round(id.openingRangeLow).toLocaleString()}원) 재이탈`);
  }
  if (macro.sox) parts.push("미 반도체지수(SOX) 선물·장중 흐름이 급격히 반전 하락");
  if (parts.length === 0) return null;
  return `${parts.join(" 또는 ")} 발생 시, 목표가·손절가 도달 여부와 무관하게 매매 논리 자체가 무효화된 것으로 보고 즉시 재검토·정리하세요.`;
}

function buildScaledEntry(price: number, qty: number | null): ScaledOrder[] {
  if (!qty || qty < 2) {
    return qty ? [{ price: Math.round(price), qty, note: "1회 매수 (수량이 적어 분할 실익 없음)" }] : [];
  }
  const q1 = Math.ceil(qty * 0.6);
  const q2 = qty - q1;
  return [
    { price: Math.round(price), qty: q1, note: "1차 진입 (60%) — 진입 트리거 충족 즉시" },
    { price: Math.round(price * 0.985), qty: q2, note: "2차 진입 (40%) — 추가 눌림 시 (물타기 아닌 사전 계획된 분할매수)" },
  ];
}

function buildScaledExit(entryPrice: number, targetPrice: number | null, qty: number | null): ScaledOrder[] {
  if (!targetPrice || !qty) return [];
  const t1 = Math.round(entryPrice + (targetPrice - entryPrice) * 0.5);
  const q1 = Math.ceil(qty * 0.5);
  return [
    { price: t1, qty: q1, note: "1차 익절 (50%) — 손익비 1:1 도달 시 우선 실현" },
    { price: targetPrice, qty: qty - q1, note: "2차 익절 (나머지) — 목표가 도달 또는 트레일링 스탑으로 관리" },
  ];
}

// 룰 엔진의 0~100점 종합 점수를 "미보유 시 매수 강도" 0~10점으로 환산.
// 엔진의 실제 진입 임계값(58=근접 관망, 68=신규매수)에 눈금을 맞춰 초보자도
// "7점 이상이면 엔진 기준 진짜 매수 신호"라고 바로 알 수 있게 한다.
function scoreToBuyStrength(score: number): number {
  if (score >= 88) return 10;
  if (score >= 80) return 9;
  if (score >= 72) return 8;
  if (score >= 68) return 7; // 엔진 신규매수 임계값
  if (score >= 63) return 6;
  if (score >= 58) return 4; // 매수 근접(관망)
  if (score >= 52) return 2;
  if (score >= 45) return 1;
  return 0;
}

// 보유 중일 때 "지금 얼마나 강하게 팔아야 하는가" 0~10점.
// 손절선 이탈/큰 손실은 즉시 10점, 그 외엔 종합 점수·목표가 도달·과열 여부로 판단.
function computeSellStrength(params: {
  price: number;
  stopPrice: number | null;
  targetPrice: number | null;
  score: number;
  pnlPct: number;
  rsi14: number;
}): number {
  const { price, stopPrice, targetPrice, score, pnlPct, rsi14 } = params;
  if (stopPrice != null && price <= stopPrice) return 10; // 손절선 이탈 — 즉시
  if (pnlPct <= -7) return 10; // 손실 -7% 초과 — 즉시
  if (score <= 25) return 9;
  if (score <= 32) return 8; // 엔진 전량매도 임계값
  if (targetPrice != null && price >= targetPrice && score < 60) return 8; // 목표가 도달 + 모멘텀 둔화
  if (targetPrice != null && price >= targetPrice) return 6; // 목표가 도달, 모멘텀은 유지
  if (rsi14 >= 75 && pnlPct > 3) return 5; // 과열 + 수익 중 — 일부 차익실현 고려
  if (score <= 40) return 5;
  if (score <= 48) return 3;
  if (score <= 55) return 1;
  return 0; // 보유 유지 (신호 양호)
}

function buyStrengthSummary(buyStrength: number, price: number): string {
  if (buyStrength >= 7) return `지금 매수 강도 ${buyStrength}/10 — 엔진 기준 진입 신호 충족`;
  if (buyStrength >= 4) return `매수 대기 강도 ${buyStrength}/10 — ${won0(price)}원 부근, 트리거 확인 필요`;
  return `관망 강도(매수 아님) ${buyStrength}/10 — 아직 근거 부족`;
}

function sellStrengthSummary(sellStrength: number, stopPrice: number | null, targetPrice: number | null): string {
  if (sellStrength >= 9) return `즉시 매도 강도 ${sellStrength}/10 — 손절선(${won0(stopPrice)}원) 기준 원칙대로 정리`;
  if (sellStrength >= 6) return `매도 강도 ${sellStrength}/10 — 목표가(${won0(targetPrice)}원) 부근, 분할 매도 고려`;
  if (sellStrength >= 3) return `일부 경계 강도 ${sellStrength}/10 — 손절선(${won0(stopPrice)}원) 주시하며 보유`;
  return `보유 유지 강도(매도 아님) ${sellStrength}/10 — 신호 양호`;
}

function won0(n: number | null): string {
  return n == null ? "-" : Math.round(n).toLocaleString("ko-KR");
}

// 전문가가 초보자에게 말하듯 쉬운 한 문장 + 구체적 근거(추세선/거래량/환율 등)를 결합한 판정문.
// AI 없이도(또는 AI 실패 시 대체용으로) 항상 "학습된 엔진 기반"으로 일관되게 나오도록 순수 계산으로만 만든다.
function verbPhrase(
  held: boolean,
  action: Action,
  buyStrength: number,
  sellStrength: number,
  overheated: boolean,
): { text: string; tone: "buy" | "sell" | "danger" | "neutral" } {
  if (!held) {
    if (overheated) return { text: "지금은 추격 매수하지 마세요 (절대 금지)", tone: "danger" };
    if (action === "신규매수" && buyStrength >= 8) return { text: "지금 사도 좋아요", tone: "buy" };
    if (action === "신규매수") return { text: "매수를 고려해볼 만해요", tone: "buy" };
    if (buyStrength >= 4) return { text: "조건이 갖춰지면 매수를 고려하세요", tone: "neutral" };
    return { text: "지금은 매수하지 마세요", tone: "neutral" };
  }
  if (action === "손절") return { text: "지금 즉시 매도하세요 (손절 원칙)", tone: "danger" };
  if (action === "전량매도") return { text: "지금 전량 매도를 고려하세요", tone: "sell" };
  if (action === "부분매도") return { text: "일부만 매도하는 것을 고려하세요", tone: "sell" };
  if (action === "추가매수") return { text: "추가 매수를 고려해볼 만해요", tone: "buy" };
  if (sellStrength <= 2) return { text: "계속 보유하세요", tone: "neutral" };
  return { text: "보유하되 주의 깊게 지켜보세요", tone: "neutral" };
}

function buildVerdict(params: {
  held: boolean;
  action: Action;
  buyStrength: number;
  sellStrength: number | null;
  reasons: string[];
  warnings: string[];
  overheated: boolean;
}): string {
  const { held, action, buyStrength, reasons, warnings, overheated } = params;
  const sellStrength = params.sellStrength ?? 0;
  const { text, tone } = verbPhrase(held, action, buyStrength, sellStrength, !held && overheated);
  // 근거 문장 선택: 매수 쪽 판정이면 긍정 근거(reasons)를, 위험/매도 쪽 판정이면 경고(warnings)를 우선 인용한다.
  const groundingPool = tone === "buy" ? [...reasons, ...warnings] : [...warnings, ...reasons];
  const grounding = groundingPool[0];
  const icon = tone === "buy" ? "🟢" : tone === "sell" ? "🔵" : tone === "danger" ? "🔴" : "⚪";
  return grounding ? `${icon} ${text} — ${grounding}` : `${icon} ${text}`;
}

export function runEngine(params: {
  ticker: StockTicker;
  price: number;
  candles: Candle[];
  macro: MacroSnapshot;
  news: NewsItem[];
  portfolio: Portfolio;
  intraday: IntradayInsight | null;
  marketPhase: MarketPhaseInfo;
  relativeStrengthNote?: string | null;
  backtest?: BacktestStats | null;
  disclosures?: DartFiling[];
  investorFlow?: InvestorFlowDay[];
}): EngineSignal {
  const { ticker, price, candles, macro, news, portfolio, intraday, marketPhase } = params;
  const name = STOCKS[ticker].name;
  const ind = computeIndicators(candles);

  const tech = technicalScore(ind, price);
  const mac = macroScore(macro, marketPhase);
  const sent = newsSentimentScore(news, name);
  const intra = intradayScore(intraday);
  const disc = disclosureScore(params.disclosures);
  const flow = investorFlowScore(params.investorFlow, ind.avgVolume20);

  // 장초반/점심시간대는 신호 신뢰도가 낮으므로 가중치를 낮춘다 (과최적화된 진입 방지)
  const phaseDampener = marketPhase.phase === "장초반" || marketPhase.phase === "점심시간대" ? 0.7 : 1;

  let score = Math.max(
    0,
    Math.min(100, 50 + (tech.score - 50 + mac.score + sent.score + intra.score + disc.score + flow.score) * phaseDampener),
  );
  const reasons = [...intra.reasons, ...tech.reasons, ...mac.notes, ...disc.notes, ...flow.notes];
  const warnings = [...intra.warnings, ...tech.warnings, ...mac.warnings, ...sent.notes, ...disc.warnings, ...flow.warnings];
  if (phaseDampener < 1) {
    warnings.push(`현재 시간대(${marketPhase.phase})는 신호 신뢰도가 평소보다 낮습니다 — ${marketPhase.note}`);
  }

  const holding = portfolio.holdings.find((h) => h.ticker === ticker && h.qty > 0) ?? null;
  const totalHoldingValue = portfolio.holdings.reduce((a, h) => a + h.qty * price, 0);
  const totalAsset = portfolio.cash + totalHoldingValue;

  // 단타용 손절폭: 일봉 ATR과 당일 오프닝레인지 폭 중 더 타이트한 쪽을 우선 사용
  const dailyAtrDist = isNaN(ind.atr14) ? price * 0.03 : Math.max(ind.atr14 * 1.5, price * 0.02);
  const orRangeDist =
    intraday?.available && intraday.openingRangeHigh != null && intraday.openingRangeLow != null
      ? intraday.openingRangeHigh - intraday.openingRangeLow
      : null;
  const atrStopDist = orRangeDist && orRangeDist > price * 0.005 ? Math.min(dailyAtrDist, orRangeDist * 1.3) : dailyAtrDist;

  // 기술적/기본적 교차 검증 보정: 뉴스·매크로가 아무리 우호적이어도 RSI 과매수(72+) 또는
  // 당일 고가권(레인지 상위 95%+) 근접이면 신규 진입을 보류한다 (미보유 시에만 의미 있는 판단).
  const overheatedNow = ind.rsi14 > 72 || (intraday?.available === true && intraday.rangePositionPct >= 95);

  let action: EngineSignal["action"] = "관망";
  let targetPrice: number | null = null;
  let stopPrice: number | null = null;
  let suggestedBudget: number | null = null;
  let suggestedQty: number | null = null;
  let pnlPct: number | null = null;
  let entryTriggers: string[] = [];
  let scaledEntry: ScaledOrder[] = [];
  let scaledExit: ScaledOrder[] = [];

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
    scaledExit = buildScaledExit(holding.avgPrice, targetPrice, holding.qty);
  } else {
    // 미보유 — 단타용 진입 트리거를 항상 제시 (지금 조건 미충족이어도 "무엇을 봐야 하는지" 알려줌)
    stopPrice = Math.round(price - atrStopDist);
    targetPrice = Math.round(price + atrStopDist * 2);
    entryTriggers = buildEntryTriggers(intraday, ind);

    if (score >= 68 && overheatedNow) {
      action = "관망";
      warnings.unshift(
        `기술적 과열 보정 — 종합 점수(${Math.round(score)}점)는 매수 신호였지만 RSI ${ind.rsi14.toFixed(0)}(과매수) 또는 당일 고가권 근접으로 신규 진입을 보류합니다. 뉴스·매크로가 우호적이어도 추격 매수는 금지, 눌림목 또는 과열 해소 후 재진입 검토`,
      );
    } else if (score >= 68 && portfolio.cash > price) {
      action = "신규매수";
      const budget = Math.min(portfolio.cash * ENTRY_FRACTION, (totalAsset * RISK_PER_TRADE * price) / atrStopDist);
      suggestedBudget = Math.floor(budget);
      suggestedQty = Math.max(1, Math.floor(budget / price));
      reasons.unshift(`진입 신호 충족 (점수 ${Math.round(score)}) — 분할 매수 권장, 진입 즉시 손절가 설정`);
      scaledEntry = buildScaledEntry(price, suggestedQty);
      scaledExit = buildScaledExit(price, targetPrice, suggestedQty);
    } else if (score >= 58) {
      action = "관망";
      reasons.unshift("매수 근접 구간 — 아래 진입 트리거 충족 시까지 대기");
    } else {
      action = "관망";
    }
  }

  const suggestedEntryPrice = holding ? null : computeSuggestedEntryPrice(action, price, intraday, ind);

  const invalidation = buildInvalidation(intraday, macro);

  // 왕복 거래비용(증권거래세+수수료) 추정 — 목표가가 비용 대비 실익이 얇으면 경고
  let estimatedRoundTripCostWon: number | null = null;
  if (holding && holding.qty > 0) {
    estimatedRoundTripCostWon = Math.round(holding.qty * price * ROUND_TRIP_COST_PCT);
  } else if (suggestedBudget) {
    estimatedRoundTripCostWon = Math.round(suggestedBudget * ROUND_TRIP_COST_PCT);
  }
  if (targetPrice && (action === "신규매수" || action === "추가매수")) {
    const profitPct = ((targetPrice - price) / price) * 100;
    if (profitPct < ROUND_TRIP_COST_PCT * 100 * 3) {
      warnings.push(
        `목표가까지 예상 수익률(${profitPct.toFixed(2)}%)이 거래비용(왕복 약 ${(ROUND_TRIP_COST_PCT * 100).toFixed(2)}%) 대비 여유가 크지 않습니다 — 실익 재확인 필요`,
      );
    }
  }

  const confidence: EngineSignal["confidence"] =
    score >= 72 || score <= 28 ? "높음" : score >= 60 || score <= 40 ? "중간" : "낮음";

  // 초보자도 한눈에 판단할 수 있도록 0~10점 단일 지표로 환산.
  // 미보유 시: "지금 얼마나 강하게 사야 하는가" (buyStrength)
  // 보유 중: "지금 얼마나 강하게 팔아야 하는가" (sellStrength)
  const buyStrength = scoreToBuyStrength(score);
  const sellStrength = holding ? computeSellStrength({ price, stopPrice, targetPrice, score, pnlPct: pnlPct ?? 0, rsi14: ind.rsi14 }) : null;
  const actionSummary = holding
    ? sellStrengthSummary(sellStrength as number, stopPrice, targetPrice)
    : buyStrengthSummary(buyStrength, price);
  const verdict = buildVerdict({ held: Boolean(holding), action, buyStrength, sellStrength, reasons, warnings, overheated: overheatedNow });

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
    intraday,
    marketPhase,
    entryTriggers,
    invalidation,
    scaledEntry,
    scaledExit,
    relativeStrengthNote: params.relativeStrengthNote ?? null,
    estimatedRoundTripCostWon,
    backtest: params.backtest ?? null,
    buyStrength,
    sellStrength,
    actionSummary,
    verdict,
    macroScore: Math.round(mac.score),
    disclosures: params.disclosures ?? [],
    investorFlow: params.investorFlow ?? [],
    suggestedEntryPrice: suggestedEntryPrice?.price ?? null,
    entryPriceBasis: suggestedEntryPrice?.basis ?? null,
  };
}

// 5종목 + 매크로를 종합한 "오늘의 매수 매력도" 마스터 스코어.
// 개별 종목 score(이미 기술적+장중+매크로+뉴스를 반영)의 평균을 그대로 "매력도 %"로 쓴다 —
// AI 호출 없이 순수 계산이라 항상 즉시·일관되게 나오고, 개별 종목 판단과 모순되지 않는다.
export function computeMasterScore(signals: EngineSignal[]): MasterScore {
  if (signals.length === 0) {
    return {
      attractivenessPct: 50,
      label: "데이터 부족",
      tone: "neutral",
      headline: "시세/신호 데이터를 가져오지 못해 종합 판단을 할 수 없습니다.",
      buyCount: 0,
      sellCount: 0,
      strongestTicker: null,
      strongestName: null,
    };
  }
  const attractivenessPct = Math.round(signals.reduce((a, s) => a + s.score, 0) / signals.length);
  const buyCount = signals.filter((s) => s.score >= 68).length;
  const sellCount = signals.filter((s) => s.score <= 32).length;
  const strongest = [...signals].sort((a, b) => b.score - a.score)[0];

  let label: string;
  let tone: MasterScore["tone"];
  if (attractivenessPct >= 68) {
    label = "매수 우위";
    tone = "buy";
  } else if (attractivenessPct >= 45) {
    label = "중립/관망";
    tone = "neutral";
  } else {
    label = "방어적(매도 우위)";
    tone = "sell";
  }

  let headline: string;
  if (buyCount > 0) {
    headline = `${signals.length}종목 중 ${buyCount}종목이 매수 신호권 — 가장 강한 종목은 ${strongest.name}(${strongest.score}점)`;
  } else if (sellCount > 0) {
    headline = `${signals.length}종목 중 ${sellCount}종목이 매도/경계 신호권 — 신규 진입보다 리스크 관리를 우선하세요`;
  } else {
    headline = `뚜렷한 매수·매도 신호 없이 관망 우위 — 가장 근접한 종목은 ${strongest.name}(${strongest.score}점)`;
  }

  return { attractivenessPct, label, tone, headline, buyCount, sellCount, strongestTicker: strongest.ticker, strongestName: strongest.name };
}

// 반도체 N종목 상대강도 순위 — 단타에서는 "가장 강한 놈"을 골라 타는 게 원칙.
// 종목이 늘어난 만큼(최대 5개) 페어 비교가 아니라 전체 랭킹으로 계산한다.
export function computeRelativeStrength(
  stocks: { ticker: StockTicker; changePct: number }[],
): { ranked: RankedStock[]; noteFor: (ticker: StockTicker) => string; summary: string } {
  const ranked: RankedStock[] = [...stocks]
    .sort((a, b) => b.changePct - a.changePct)
    .map((s, i) => ({ ticker: s.ticker, name: STOCKS[s.ticker].name, changePct: s.changePct, rank: i + 1 }));
  const total = ranked.length;

  const noteFor = (ticker: StockTicker): string => {
    const r = ranked.find((x) => x.ticker === ticker);
    if (!r || total < 2) return "";
    const pctStr = `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`;
    if (r.rank === 1) return `반도체 ${total}종목 중 등락률 1위(${pctStr}) — 오늘 가장 강한 종목, 단타 우선순위 상위`;
    if (r.rank === total) return `반도체 ${total}종목 중 등락률 최하위(${pctStr}) — 상대적으로 약세, 진입 시 더 보수적으로 접근`;
    return `반도체 ${total}종목 중 ${r.rank}위(${pctStr})`;
  };

  const summary =
    total >= 2
      ? `오늘의 순위: ${ranked.map((r) => `${r.name} ${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`).join(" > ")}`
      : "";

  return { ranked, noteFor, summary };
}

// 섹터 집중도 점검 — 5종목 모두 반도체라 여러 종목에 나눠 담아도 사실상 단일 섹터 베팅이다.
// "비판자" 관점 보완: 분산투자로 착각하게 두지 않고 명시적으로 경고한다.
export function computeSectorConcentration(
  holdings: Portfolio["holdings"],
  quotes: Record<string, { price: number } | null | undefined>,
  totalAsset: number,
): { pct: number; warning: string | null } {
  if (totalAsset <= 0) return { pct: 0, warning: null };
  const semiValue = holdings.reduce((sum, h) => {
    const q = quotes[h.ticker];
    return sum + h.qty * (q?.price ?? h.avgPrice);
  }, 0);
  const pct = (semiValue / totalAsset) * 100;
  if (pct >= 70) {
    return {
      pct,
      warning: `보유 자산의 ${pct.toFixed(0)}%가 반도체 섹터에 집중되어 있습니다 — 여러 종목에 나눠 담아도 반도체 업황이 동시에 흔들리면 분산 효과가 거의 없습니다. 전체 포지션 크기를 재고하세요.`,
    };
  }
  return { pct, warning: null };
}
