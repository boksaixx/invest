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
  VolForecast,
} from "./types";
import { isSemiconductor, STOCKS } from "./types";
import { computeIndicators } from "./indicators";
import { CORRELATED_PAIR_MAX_WEIGHT, forecastVolatility } from "./volatility";
import { roundToTick } from "./tick";
import { computeUpRate } from "./upRate";
import { buildForecastPath, driftFromScenario, kstMinutesNow } from "./forecastPath";
import { computeScenarioOutlook, type ScenarioTable } from "./scenario";
import { computePriceLimits } from "./priceLimits";

const MAX_POSITION_WEIGHT = 0.5; // 한 종목 최대 비중 (총자산 대비)
const ENTRY_FRACTION = 0.25; // 1회 매수 시 현금 대비 최대 비율
const RISK_PER_TRADE = 0.01; // 1회 매매 허용 손실 = 총자산의 1%
// 왕복 거래비용 — 국내 주식은 "매도할 때만" 세금을 낸다. 매수에는 수수료만 붙는다.
//
//   매도 시 세금   0.15%  (2025년 이후 코스피·코스닥 공통. 코스피는 증권거래세 0% + 농어촌특별세 0.15%,
//                        코스닥은 증권거래세 0.15%. 2024년까지는 0.18%였다가 인하됐다)
//   위탁수수료     0.015% × 2 (매수·매도 각각. 온라인 기준 증권사별 0.0036~0.05%로 편차가 있다)
//   ─────────────────────────────
//   왕복 합계      약 0.18%
//
// 이 값은 "최소한 이만큼 올라야 본전"이라는 뜻이다. 세율은 정책에 따라 바뀌므로
// 실제 체결 내역의 수수료·세금과 다르면 이 상수를 고쳐야 한다.
export const SELL_TAX_PCT = 0.0015;
export const BROKER_FEE_PCT = 0.00015;
const ROUND_TRIP_COST_PCT = SELL_TAX_PCT + BROKER_FEE_PCT * 2; // 0.18%

export function newsSentimentScore(news: NewsItem[], stockName: string): { score: number; notes: string[] } {
  let score = 0;
  const notes: string[] = [];
  for (const n of news) {
    const related =
      n.relatedTo.includes(stockName) ||
      n.relatedTo.includes("반도체") ||
      n.relatedTo.includes("AI") ||
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

  // 연기금 순매수 연속 — 연기금(국민연금 등)은 단타가 아니라 장기 자금이라, 며칠 연속
  // 순매수가 이어지면 "급락해도 받아주는 큰손이 있다"는 하방 지지 신호로 읽는다.
  // (KRX 상세 응답이 있을 때만 판단 — 데이터가 없으면 조용히 건너뜀)
  const withPension = flows.filter((f) => f.pensionNet != null);
  if (withPension.length >= 3) {
    const last3 = withPension.slice(-3);
    const sum3 = last3.reduce((a, f) => a + (f.pensionNet ?? 0), 0);
    // 연기금은 거래대금 자체가 크지 않아(3일 합계가 20일평균거래량의 0.2~0.5% 수준이 보통)
    // 규모보다 "방향의 지속성"이 신호다. 노이즈만 걸러낼 만큼만 임계값을 둔다.
    const meaningful = Math.abs(sum3) / avgVolume20 > 0.002;
    if (meaningful && last3.every((f) => (f.pensionNet ?? 0) > 0)) {
      score += 2;
      notes.push(`연기금 3일 연속 순매수(합 ${sum3.toLocaleString()}주) — 장기 자금이 하방을 받치는 중`);
    } else if (meaningful && last3.every((f) => (f.pensionNet ?? 0) < 0)) {
      score -= 1;
      warnings.push(`연기금 3일 연속 순매도(합 ${Math.abs(sum3).toLocaleString()}주) — 장기 자금 이탈 흐름`);
    }
  }
  return { score, notes, warnings };
}

function macroScore(macro: MacroSnapshot, marketPhase: MarketPhaseInfo): { score: number; notes: string[]; warnings: string[] } {
  let score = 0;
  const notes: string[] = [];
  const warnings: string[] = [];
  if (macro.sox) {
    // 폭등/폭락(±3.5% 이상) 구간은 요즘처럼 SOX가 하루에도 크게 흔들리는 장세를 반영해 별도 최상위
    // 티어로 훨씬 강하게 가중치를 준다 — 간밤 SOX 급변동은 다음날 국내 반도체주 갭(시가 급등/급락)으로
    // 거의 그대로 이어지는 경우가 많다.
    if (macro.sox.changePct >= 3.5) {
      score += 16;
      notes.push(`미 반도체지수(SOX) 폭등 +${macro.sox.changePct.toFixed(1)}% — 초강세, 오늘 국내 반도체주 갭상승 가능성 큼`);
    } else if (macro.sox.changePct >= 1.5) {
      score += 10;
      notes.push(`미 반도체지수(SOX) 강세 +${macro.sox.changePct.toFixed(1)}%`);
    } else if (macro.sox.changePct >= 0.3) score += 5;
    else if (macro.sox.changePct <= -3.5) {
      score -= 16;
      warnings.push(`미 반도체지수(SOX) 폭락 ${macro.sox.changePct.toFixed(1)}% — 초약세, 오늘 국내 반도체주 갭하락 위험 큼, 신규 진입 보수적으로`);
    } else if (macro.sox.changePct <= -1.5) {
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

  // 국제 유가(WTI) 급변동 — 급등이든 급락이든 방향과 무관하게 매크로 리스크가 커진 신호로 다룬다
  // (급등=인플레이션/지정학 리스크, 급락=수요둔화·경기침체 우려로 둘 다 증시엔 부담 요인인 경우가 많음).
  if (macro.oil) {
    if (Math.abs(macro.oil.changePct) >= 4) {
      score -= 5;
      warnings.push(`국제 유가(WTI) 급변동 ${macro.oil.changePct >= 0 ? "+" : ""}${macro.oil.changePct.toFixed(1)}% — 매크로 리스크 확대 신호, 변동성 확대 유의`);
    } else if (Math.abs(macro.oil.changePct) >= 2) {
      score -= 2;
      notes.push(`국제 유가(WTI) ${macro.oil.changePct >= 0 ? "+" : ""}${macro.oil.changePct.toFixed(1)}%`);
    }
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
  currency: "KRW" | "USD" = "KRW",
): { price: number; basis: string } | null {
  const tick = (v: number) => roundToTick(v, currency, "nearest");
  if (action === "신규매수") {
    return { price: tick(price), basis: "현재가 기준 즉시 진입 (분할매수 1차 라인 참고)" };
  }
  if (action === "추가매수") {
    return { price: tick(price), basis: "현재가 기준 추가 매수(피라미딩) — 수익 중 + 신호 강세 조건 충족 시에만 제안됨" };
  }
  if (action === "관망") {
    if (intraday?.available) {
      return {
        price: tick(intraday.vwap),
        basis: `VWAP(${tick(intraday.vwap).toLocaleString()}원) 상향 돌파 + 거래량 증가 확인 시 진입`,
      };
    }
    return { price: tick(ind.ma20), basis: `20일선(${tick(ind.ma20).toLocaleString()}원) 회복 확인 시 진입 검토 (장중 데이터 미확보)` };
  }
  return null;
}

// 진입 트리거는 전부 "지금 가격이 어느 선 위/아래냐"라는 절대 가격 기준으로만 쓴다.
// 특정 시각의 분봉 모양(예: "9시 30분 캔들이 양봉이면")을 기준으로 삼으면 그 시간에 화면을
// 보지 못한 사람에게는 쓸모가 없다. 아래 기준들은 10시에 보든 2시에 보든 그대로 판정된다.
function buildEntryTriggers(id: IntradayInsight | null, ind: Indicators): string[] {
  const triggers: string[] = [];
  // 피벗 지지/저항은 전일 고저종만으로 정해져 장중 내내 고정이다 — 장중 데이터가 없어도 쓸 수 있는
  // 유일한 절대 기준이라 항상 함께 제시한다.
  const pivot = isNaN(ind.pivotS1)
    ? null
    : `피벗 지지선(${Math.round(ind.pivotS1).toLocaleString()}원) 이탈 없이 지지 확인 시 분할 진입 / 피벗 저항(${Math.round(ind.pivotR1).toLocaleString()}원) 돌파 시 추세 진입`;
  if (!id || !id.available) {
    triggers.push(`20일선(${Math.round(ind.ma20).toLocaleString()}원) 회복 확인 후 진입 검토 (장중 데이터 미확보로 보수적 접근)`);
    if (pivot) triggers.push(pivot);
    return triggers;
  }
  triggers.push(`VWAP(${Math.round(id.vwap).toLocaleString()}원) 상향 돌파 + 거래량 증가 동반 시 1차 진입`);
  if (id.openingRangeHigh) {
    triggers.push(`오프닝레인지 상단(${Math.round(id.openingRangeHigh).toLocaleString()}원) 돌파 후 되돌림(눌림목)에서 진입`);
  }
  if (pivot) triggers.push(pivot);
  if (id.gapType === "갭하락") {
    triggers.push(`당일 저가(${Math.round(id.todayLow).toLocaleString()}원) 지지 확인(이탈 없이 반등) 시 반발매수 진입`);
  }
  return triggers;
}

/**
 * 상관이 높은 종목과의 합산 비중 한도로 매수 예산을 깎는다.
 *
 * 개별 종목 비중만 보면 "상관 0.9인 두 종목에 반반"이 걸러지지 않는다 —
 * 위험은 한 종목에 전액 넣은 것과 같은데 규칙상으로는 분산으로 통과되기 때문.
 */
function applyCorrelationCap(
  budget: number,
  price: number,
  headroom: number | null | undefined,
  warnings: string[],
): { budget: number; qty: number } {
  const raw = Math.floor(budget);
  const rawQty = Math.max(1, Math.floor(budget / price));
  if (headroom == null || !isFinite(headroom)) return { budget: raw, qty: rawQty };

  if (headroom < price) {
    warnings.unshift(
      `상관 종목 합산 비중 한도(총자산의 ${(CORRELATED_PAIR_MAX_WEIGHT * 100).toFixed(0)}%)에 도달해 이 종목은 더 담지 않습니다 — ` +
        `이미 보유한 종목과 거의 같이 움직여서, 더 사면 분산이 아니라 같은 베팅을 키우는 것이 됩니다.`,
    );
    return { budget: 0, qty: 0 };
  }
  if (headroom < budget) {
    const qty = Math.max(1, Math.floor(headroom / price));
    warnings.push(
      `상관 종목 합산 비중 한도로 매수 수량을 ${rawQty}주 → ${qty}주로 줄였습니다 — ` +
        `이미 보유한 종목과 상관이 높아 합산 ${(CORRELATED_PAIR_MAX_WEIGHT * 100).toFixed(0)}%를 넘기지 않도록 제한합니다.`,
    );
    return { budget: Math.floor(qty * price), qty };
  }
  return { budget: raw, qty: rawQty };
}

/**
 * 자동 감시주문(HTS/MTS 예약주문) 지침.
 *
 * "매수하면 무조건 예약을 걸어라"는 규칙은 데이터가 지지하지 않는다.
 * scripts/validate-watch-orders.ts 실측(5년, 5종목):
 *  - 하루 이상 못 보는 경우: 최악 -34.0% → -20.0%, -10% 이하 손실 비율 4.8% → 2.4%로 반토막.
 *    꼬리를 확실히 자른다.
 *  - 당일 안에 다시 볼 수 있는 경우(1거래일): 최악이 오히려 -17.8% → -19.1%로 나빠지고
 *    건당 평균도 낮았다. 스톱을 스치고 되돌아오는 날(76회)이 실제로 구제된 날(56회)보다 많다.
 * 그래서 "며칠 못 볼 것 같으면 손절 예약은 필수, 당일 확인 가능하면 선택"으로 조건부 제시한다.
 */
function buildWatchOrderNote(
  action: Action,
  price: number,
  stopPrice: number | null,
  targetPrice: number | null,
  currency: "KRW" | "USD",
): string | null {
  if (action === "관망" || stopPrice == null || !(stopPrice > 0)) return null;
  const fmt = (v: number) => (currency === "USD" ? `$${v.toFixed(2)}` : `${Math.round(v).toLocaleString()}원`);
  const stopPct = ((price - stopPrice) / price) * 100;
  const targetPart = targetPrice && targetPrice > 0 ? ` 익절 예약은 ${fmt(targetPrice)}에 절반만 걸어두세요(나머지는 추세를 따라가게).` : "";
  return (
    `내일까지 차트를 못 볼 것 같으면 증권사 앱에서 손절 감시주문을 ${fmt(stopPrice)}(현재가 대비 -${stopPct.toFixed(1)}%)에 미리 걸어두세요.` +
    ` 5년 실측상 하루 이상 방치하면 최악의 손실이 -34%까지 갔지만, 예약을 걸어두면 -20%에서 끊겼습니다(-10% 넘는 손실 비율도 4.8%→2.4%).` +
    `${targetPart}` +
    ` 다만 당일 안에 다시 확인할 수 있다면 예약이 오히려 불리했습니다 — 잠깐 스치고 되돌아오는 날에 기계적으로 털리기 때문입니다.`
  );
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

function buildScaledEntry(price: number, qty: number | null, currency: "KRW" | "USD"): ScaledOrder[] {
  const tick = (v: number) => roundToTick(v, currency, "nearest");
  if (!qty || qty < 2) {
    return qty ? [{ price: tick(price), qty, note: "1회 매수 (수량이 적어 분할 실익 없음)" }] : [];
  }
  const q1 = Math.ceil(qty * 0.6);
  const q2 = qty - q1;
  return [
    { price: tick(price), qty: q1, note: "1차 진입 (60%) — 진입 트리거 충족 즉시" },
    { price: tick(price * 0.985), qty: q2, note: "2차 진입 (40%) — 추가 눌림 시 (물타기 아닌 사전 계획된 분할매수)" },
  ];
}

function buildScaledExit(entryPrice: number, targetPrice: number | null, qty: number | null, currency: "KRW" | "USD"): ScaledOrder[] {
  if (!targetPrice || !qty) return [];
  // 익절가는 내림 — 올리면 도달이 어려워져 제시한 계획보다 불리해진다
  const t1 = roundToTick(entryPrice + (targetPrice - entryPrice) * 0.5, currency, "down");
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

/**
 * 매수 강도를 한 줄로 옮긴다.
 *
 * entryBlocked = 점수는 진입 문턱을 넘었는데 과열·변동성·상관한도·하루손실한도가 막은 상태.
 * 이때 "진입 신호 충족"이라고 쓰면 바로 아래 판정문("추격 매수 절대 금지")과 정면으로 부딪힌다.
 * 실제로 그렇게 나갔던 문장이라 여기서 명시적으로 갈라준다.
 */
function buyStrengthSummary(buyStrength: number, price: number, entryBlocked: boolean, rawScore: number): string {
  if (entryBlocked) return `점수는 ${Math.round(rawScore)}점으로 높지만 지금은 진입하지 않습니다 — 아래 경고 확인`;
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
  /** 점수는 진입 문턱을 넘었는데 과열·변동성·상관한도·하루손실한도가 막은 상태 */
  entryBlocked: boolean,
): { text: string; tone: "buy" | "sell" | "danger" | "neutral" } {
  if (!held) {
    if (overheated) return { text: "지금은 추격 매수하지 마세요 (절대 금지)", tone: "danger" };
    // 막힌 이유가 과열이 아닐 때(변동성·상관한도·하루손실한도)도 "매수를 고려하세요"라고 하면
    // 바로 아래 경고문("신규 매수를 멈췄습니다")과 정면으로 부딪힌다. 실제로 그렇게 나갔다.
    if (entryBlocked) return { text: "점수는 좋지만 지금 살 자리는 아니에요", tone: "neutral" };
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
  entryBlocked: boolean;
}): string {
  const { held, action, buyStrength, reasons, warnings, overheated, entryBlocked } = params;
  const sellStrength = params.sellStrength ?? 0;
  const { text, tone } = verbPhrase(held, action, buyStrength, sellStrength, !held && overheated, !held && entryBlocked);
  // 근거 문장 선택: 매수 쪽 판정이면 긍정 근거(reasons)를, 위험/매도 쪽 판정이면 경고(warnings)를 우선 인용한다.
  const groundingPool = tone === "buy" ? [...reasons, ...warnings] : [...warnings, ...reasons];
  const grounding = groundingPool[0];
  const icon = tone === "buy" ? "🟢" : tone === "sell" ? "🔵" : tone === "danger" ? "🔴" : "⚪";
  return grounding ? `${icon} ${text} — ${grounding}` : `${icon} ${text}`;
}

// 변동성 경고 문구 — 추정 모델이 살아있으면 실제 예상 등락폭(원 단위까지)을 말해주고,
// 모델이 없을 때만 구 지표(120일 대비 배율)로 물러선다.
function volatilityHeadline(vf: VolForecast, ind: Indicators): string {
  if (!vf.available) {
    return `변동성 급확대 — 최근 변동폭이 평소(120일 평균) 대비 ${ind.volatilityRatio.toFixed(1)}배 커진 상태입니다.`;
  }
  return `변동성 ${vf.regime} — 지금 이 종목은 하루에 평균 ±${vf.sigmaDailyPct.toFixed(1)}%(연율 ${vf.annualizedPct.toFixed(0)}%) 움직이고 있고, 이는 평소의 ${vf.regimeRatio.toFixed(1)}배입니다.`;
}

function volatilityWarning(vf: VolForecast, ind: Indicators, price: number, mode: "보유" | "신규"): string {
  const head = volatilityHeadline(vf, ind);
  if (!vf.available) {
    return `${head} ${mode === "보유" ? "추가매수 규모를 줄이고" : "진입 예산을 축소했습니다."} 손절선을 더 엄격히 관리하세요.`;
  }
  const lo = Math.round((price * vf.range90.lowPct) / 100);
  const hi = Math.round((price * vf.range90.highPct) / 100);
  const skewNote =
    vf.skew === "상방"
      ? " 최근에는 급등 쪽 꼬리가 더 두꺼워(상한가 사례) 성급한 매도가 불리할 수 있습니다."
      : vf.skew === "하방"
        ? " 최근에는 급락 쪽 꼬리가 더 두꺼우니 손절을 미루지 마세요."
        : "";
  return `${head} 내일 하루 등락 범위는 10번 중 9번꼴로 ${lo.toLocaleString()}원 ~ +${hi.toLocaleString()}원 안에 들어갑니다(주가 대비 ${vf.range90.lowPct.toFixed(1)}% ~ +${vf.range90.highPct.toFixed(1)}%). ${mode === "보유" ? "추가매수 규모를 줄이고" : "그만큼 진입 예산을 축소했습니다."} 손절선을 이 범위 밖에 두어야 노이즈에 털리지 않습니다.${skewNote}`;
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
  // 시장 전체 신용융자 잔고(빚투) 추이 — 20영업일 대비 급증이면 급락 시 반대매매 연쇄 위험.
  // KOFIA 공개 통계 연동이 실패하면 null로 들어오고, 이 신호 없이 정상 동작한다.
  creditTrend?: { change20dPct: number; note: string } | null;
  // 이 종목과 "같은 통화" 기준 총자산(현금+보유평가금) — 원화 종목은 원화 총자산, 달러 종목은
  // 달러 총자산을 넘겨야 한다(환율 변환 없이 같은 단위로 비교하기 위함). 호출부가 여러 종목의
  // 정확한 현재가로 계산해 넘겨주는 게 정확하며, 생략 시 이 종목 하나만 보유한다고 근사한다.
  portfolioTotalAsset?: number;
  // 전일 종가 대비 오늘 등락률(%) — 국내 종목의 상한가/하한가(가격제한폭 ±30%) 도달 여부를
  // 판단하는 데 쓴다. 생략하면 상한가/하한가 판정을 건너뛴다(다른 로직에는 영향 없음).
  changePct?: number;
  // 상관이 높은 종목과 합쳐서 이 종목에 더 넣을 수 있는 금액(해당 통화). lib/volatility.ts의
  // computeCorrelationCap 결과를 호출부가 넘긴다. 생략하면 이 한도를 적용하지 않는다.
  correlationHeadroom?: number | null;
  // 국면별 조건부 통계 테이블(data/scenarios.json). 예상 경로 차트의 아주 약한 방향성(drift)에만
  // 쓴다. 없으면 방향성 0(제자리)으로 폭만 그린다.
  scenarioTable?: ScenarioTable | null;
  // 전일 종가 — 상한가/하한가·정적VI 발동가 계산에 쓴다. 없으면 그 표시만 생략된다.
  prevClose?: number | null;
  // 계좌 하루 손실 한도에 이미 닿았는지. true면 신규 진입을 제안하지 않는다
  // (실측 근거는 lib/dailyRisk.ts 주석 참조).
  dailyStopTriggered?: boolean;
}): EngineSignal {
  const { ticker, price, candles, macro, news, portfolio, intraday, marketPhase } = params;
  const name = STOCKS[ticker].name;
  const currency = STOCKS[ticker].currency;
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

  // 시장 전체 신용잔고(빚투) 급증 — 국내 종목에만 적용. 신용이 몰린 장에서 급락이 시작되면
  // 반대매매(강제청산)가 하락을 증폭시키므로, 방향 신호가 아니라 "하방 꼬리 리스크"로 감점한다.
  if (params.creditTrend && STOCKS[ticker].market === "KR") {
    if (params.creditTrend.change20dPct >= 15) {
      score = Math.max(0, score - 3);
      warnings.push(params.creditTrend.note);
    } else if (params.creditTrend.change20dPct >= 10) {
      score = Math.max(0, score - 1);
      warnings.push(params.creditTrend.note);
    } else if (params.creditTrend.change20dPct <= -15) {
      reasons.push(params.creditTrend.note); // 청산 소진 = 하방 리스크 완화 참고
    }
  }

  const holding = portfolio.holdings.find((h) => h.ticker === ticker && h.qty > 0) ?? null;
  // 이 종목과 같은 통화의 매수 여력 (원화 종목=cash, 달러 종목=cashUSD)
  const stockCash = currency === "USD" ? portfolio.cashUSD : portfolio.cash;
  const totalAsset = params.portfolioTotalAsset ?? stockCash + (holding ? holding.qty * price : 0);

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

  // 상한가/하한가(국내 가격제한폭 ±30%) 도달 — 요즘처럼 대장주가 상한가를 치는 장세에서는
  // RSI 과매수보다 훨씬 강력하고 명확한 "오늘은 더 못 오른다/더 못 내린다" 신호다.
  // 틱 단위 반올림 때문에 정확히 30.00%가 아닐 수 있어 29.5%를 임계값으로 잡는다.
  const isKR = STOCKS[ticker].market === "KR";
  const atUpperLimit = isKR && params.changePct != null && params.changePct >= 29.5;
  const atLowerLimit = isKR && params.changePct != null && params.changePct <= -29.5;

  // 변동성 추정 모델 (lib/volatility.ts) — 5개년 실데이터로 검증한 EWMA+조건부 모델.
  // 구 volatilityRatio(120일 단순평균 대비 배율)는 레짐 전환에 뒤처져 검증에서 열위였으므로
  // 판단의 주축을 이 모델로 옮긴다(volatilityRatio는 참고 지표로만 남김).
  const volForecast = forecastVolatility(candles, {
    soxOvernightPct: macro.sox?.changePct ?? null,
    // 국내 종목만 "전일 미국장 → 오늘 국내장" 오버나이트 전이가 성립한다.
    // 미국 종목은 SOX와 같은 시간대에 움직이므로 이 보정을 적용하지 않는다.
    // SOX 오버나이트 전이(상관 0.33~0.43)는 국내 "반도체" 종목에서 실측한 관계다.
    // 방산·금융·바이오·통신에 그대로 적용하면 근거 없는 변동성 보정이 된다.
    applySox: isSemiconductor(ticker),
  });
  const volatilityRegime = volForecast.available
    ? volForecast.regime === "높음" || volForecast.regime === "극단"
    : !isNaN(ind.volatilityRatio) && ind.volatilityRatio >= 1.6;
  // 포지션 크기는 변동성에 반비례시킨다 — 같은 금액이라도 변동성이 2배면 손실 위험도 2배이므로,
  // 레짐이 올라갈수록 단계적으로 축소한다(기존의 이분법적 0.6배보다 매끄럽고 근거가 명확).
  const volatilitySizeMultiplier = !volForecast.available
    ? volatilityRegime
      ? 0.6
      : 1
    : volForecast.regime === "극단"
      ? 0.45
      : volForecast.regime === "높음"
        ? 0.7
        : volForecast.regime === "평온"
          ? 1.1
          : 1;

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
    stopPrice = roundToTick(holding.avgPrice - entryStopDist, currency, "up");
    if (price > holding.avgPrice + entryStopDist) {
      stopPrice = Math.max(stopPrice, roundToTick(price - ind.atr14 * 2, currency, "up"));
      reasons.push("수익 구간 — 트레일링 스탑(고점 추적 손절선) 적용");
    }
    if (atUpperLimit) {
      warnings.unshift(
        `오늘 상한가(+${params.changePct!.toFixed(1)}%) 도달 — 오늘은 더 이상 오를 여력이 없습니다. 추가매수는 절대 금지, 익일 시가가 크게 벌어질 수 있는 갭 리스크에 대비해 일부 차익실현을 고려하세요.`,
      );
    }
    if (atLowerLimit) {
      warnings.unshift(
        `오늘 하한가(${params.changePct!.toFixed(1)}%) 도달 — 패닉 매도 국면입니다. 저가에서 물타기하지 말고 손절 원칙을 예외 없이 지키세요.`,
      );
    }
    if (volatilityRegime) {
      warnings.push(volatilityWarning(volForecast, ind, price, "보유"));
    }
    targetPrice = roundToTick(holding.avgPrice + entryStopDist * 2, currency, "down"); // 손익비 1:2

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
      stockCash > price
    ) {
      action = "추가매수";
      const budget =
        Math.min(stockCash * ENTRY_FRACTION, (totalAsset * RISK_PER_TRADE * price) / atrStopDist) * volatilitySizeMultiplier;
      const capped = applyCorrelationCap(budget, price, params.correlationHeadroom, warnings);
      suggestedBudget = capped.budget;
      suggestedQty = capped.qty;
      if (capped.qty === 0) action = "보유"; // 상관 한도 때문에 더 담을 수 없으면 추가매수가 아니다
      else reasons.unshift("수익 중 + 신호 강세 — 피라미딩(불타기) 조건 충족");
    } else {
      action = "보유";
    }
    scaledExit = buildScaledExit(holding.avgPrice, targetPrice, holding.qty, currency);
  } else {
    // 미보유 — 단타용 진입 트리거를 항상 제시 (지금 조건 미충족이어도 "무엇을 봐야 하는지" 알려줌)
    stopPrice = roundToTick(price - atrStopDist, currency, "up");
    targetPrice = roundToTick(price + atrStopDist * 2, currency, "down");
    entryTriggers = buildEntryTriggers(intraday, ind);

    if (atUpperLimit) {
      action = "관망";
      warnings.unshift(
        `오늘 상한가(+${params.changePct!.toFixed(1)}%) 도달 — 더 이상 오늘은 오를 여력이 없습니다. 지금 추격 매수는 절대 금지, 익일 시가가 크게 벌어질 수 있는 갭 리스크(급등 출발 또는 급락 출발 모두 가능)를 확인한 뒤 재진입을 검토하세요.`,
      );
    } else if (atLowerLimit) {
      action = "관망";
      warnings.unshift(
        `오늘 하한가(${params.changePct!.toFixed(1)}%) 도달 — 패닉 매도 국면입니다. 지금 저가 매수(칼날 잡기)를 시도하지 말고 시장이 안정되고 반등 신호가 뚜렷해질 때까지 관망하세요.`,
      );
    } else if (volatilityRegime && score < 68) {
      // 변동성 급확대 상태에서는 점수가 애매한 구간(진입 근접~보통)이면 아예 관망시켜
      // 거친 장세에서 성급한 신규 진입을 막는다. 점수가 충분히 높으면(68+) 아래 분기에서
      // 정상 진입시키되 예산만 줄인다.
      action = "관망";
      warnings.unshift(
        `${volatilityHeadline(volForecast, ind)} 신호가 아직 충분히 강하지 않아(점수 ${Math.round(score)}) 신규 진입은 보류하고 변동성이 진정될 때까지 관망하세요.`,
      );
    } else if (score >= 68 && overheatedNow) {
      action = "관망";
      warnings.unshift(
        `기술적 과열 보정 — 종합 점수(${Math.round(score)}점)는 매수 신호였지만 RSI ${ind.rsi14.toFixed(0)}(과매수) 또는 당일 고가권 근접으로 신규 진입을 보류합니다. 뉴스·매크로가 우호적이어도 추격 매수는 금지, 눌림목 또는 과열 해소 후 재진입 검토`,
      );
    } else if (score >= 68 && stockCash > price) {
      const budget =
        Math.min(stockCash * ENTRY_FRACTION, (totalAsset * RISK_PER_TRADE * price) / atrStopDist) * volatilitySizeMultiplier;
      const capped = applyCorrelationCap(budget, price, params.correlationHeadroom, warnings);
      if (capped.qty === 0) {
        // 상관 한도에 걸려 살 수 없으면 "사라"고 말하면 안 된다
        action = "관망";
      } else {
        action = "신규매수";
        suggestedBudget = capped.budget;
        suggestedQty = capped.qty;
        reasons.unshift(`진입 신호 충족 (점수 ${Math.round(score)}) — 분할 매수 권장, 진입 즉시 손절가 설정`);
        if (volatilityRegime) {
          warnings.push(volatilityWarning(volForecast, ind, price, "신규"));
        }
        scaledEntry = buildScaledEntry(price, suggestedQty, currency);
        scaledExit = buildScaledExit(price, targetPrice, suggestedQty, currency);
      }
    } else if (score >= 58) {
      action = "관망";
      reasons.unshift("매수 근접 구간 — 아래 진입 트리거 충족 시까지 대기");
    } else {
      action = "관망";
    }
  }

  // 보유 중이라도 action이 "추가매수"(피라미딩)면 매수 진입가 개념이 여전히 유효하다.
  // 그 외 보유 중(매도 판단/단순 보유)에는 매수 진입가 개념이 없으므로 null.
  const suggestedEntryPrice =
    action === "신규매수" || action === "추가매수" ? computeSuggestedEntryPrice(action, price, intraday, ind, currency) : null;

  const invalidation = buildInvalidation(intraday, macro);
  const watchOrderNote = buildWatchOrderNote(action, price, stopPrice, targetPrice, currency);

  // 왕복 거래비용(증권거래세+수수료) 추정 — 목표가가 비용 대비 실익이 얇으면 경고
  let estimatedRoundTripCostWon: number | null = null;
  if (holding && holding.qty > 0) {
    estimatedRoundTripCostWon = Math.round(holding.qty * price * ROUND_TRIP_COST_PCT);
  } else if (suggestedBudget) {
    estimatedRoundTripCostWon = Math.round(suggestedBudget * ROUND_TRIP_COST_PCT);
  }

  // 본전 가격 — 초보자가 가장 자주 놓치는 숫자다.
  // "평단에 팔면 본전"이 아니다. 매도 시 세금 0.15% + 왕복 수수료를 넘겨야 비로소 손해가 아니다.
  // 보유 중이면 평단 기준, 매수를 권하는 중이면 제시한 진입가 기준으로 계산한다.
  const breakEvenBase = holding && holding.qty > 0 ? holding.avgPrice : (suggestedEntryPrice?.price ?? null);
  const breakEvenPrice =
    breakEvenBase && breakEvenBase > 0
      ? roundToTick(breakEvenBase * (1 + ROUND_TRIP_COST_PCT), currency, "up") // 올려서 잡아야 진짜 본전을 넘는다
      : null;
  if (targetPrice && (action === "신규매수" || action === "추가매수")) {
    const profitPct = ((targetPrice - price) / price) * 100;
    if (profitPct < ROUND_TRIP_COST_PCT * 100 * 3) {
      warnings.push(
        `목표가까지 예상 수익률(${profitPct.toFixed(2)}%)이 거래비용(왕복 약 ${(ROUND_TRIP_COST_PCT * 100).toFixed(2)}%) 대비 여유가 크지 않습니다 — 실익 재확인 필요`,
      );
    }
  }

  // 손절선이 "하루 정상 변동폭" 안에 있으면, 방향이 맞아도 장중 노이즈만으로 손절에 걸린다.
  // 변동성이 평소의 2~3배인 지금 같은 장세에서 초보자가 가장 많이 당하는 실패 유형이라
  // 추정 모델이 살아있을 때 명시적으로 경고한다.
  if (volForecast.available && stopPrice != null && stopPrice > 0 && price > 0) {
    const stopDistPct = ((price - stopPrice) / price) * 100;
    const oneSigma = volForecast.sigmaDailyPct;
    if (stopDistPct > 0 && stopDistPct < oneSigma) {
      warnings.push(
        `손절선이 너무 가깝습니다 — 손절까지 ${stopDistPct.toFixed(1)}%인데 이 종목은 하루 평균 ±${oneSigma.toFixed(1)}% 움직입니다. 방향을 맞혀도 장중 흔들림만으로 손절에 걸릴 가능성이 높으니, 손절선을 더 넓히거나(그만큼 수량을 줄여서) 진입 자체를 미루세요.`,
      );
    }
  }

  const confidence: EngineSignal["confidence"] =
    score >= 72 || score <= 28 ? "높음" : score >= 60 || score <= 40 ? "중간" : "낮음";

  // 초보자도 한눈에 판단할 수 있도록 0~10점 단일 지표로 환산.
  // 미보유 시: "지금 얼마나 강하게 사야 하는가" (buyStrength)
  // 보유 중: "지금 얼마나 강하게 팔아야 하는가" (sellStrength)
  // 하루 손실 한도에 닿았으면 신규·추가 매수를 제안하지 않는다.
  //
  // 종목별로는 원칙을 지켜도 같은 날 여러 종목이 함께 무너지면 계좌가 크게 빠진다.
  // 실측(scripts/validate-daily-stop.ts): -3%에서 멈추면 최대낙폭 -52.0% → -42.8%,
  // 샤프 1.16 → 1.25. 기간을 4등분해도 3개 구간에서 낙폭이 줄었고,
  // 가장 크게 무너진 두 구간에서 개선폭이 가장 컸다.
  // 매도·손절 판단은 그대로 둔다 — 멈춰야 하는 것은 "새로 사는 것"이지 "빠져나오는 것"이 아니다.
  if (params.dailyStopTriggered && (action === "신규매수" || action === "추가매수")) {
    action = "관망";
    suggestedBudget = null;
    suggestedQty = null;
    scaledEntry = [];
    entryTriggers = [];
    warnings.unshift(
      "오늘 계좌 손실이 하루 한도(-3%)에 닿아 신규 매수를 멈췄습니다. " +
        "크게 빠진 날 다음 흐름은 예측되지 않았습니다(5년 실측 -3% 이하 86일의 다음날 승률 50%). " +
        "지금은 보유분 손절선 관리에만 집중하세요.",
    );
  }

  // ⚠ 여기서부터 action은 확정이다. 아래 강도 계산이 action을 참조하므로
  //   action을 바꾸는 로직은 반드시 이 줄보다 위에 있어야 한다.

  // 매수 강도는 "최종 판단"과 어긋나면 안 된다.
  //
  // 실제로 있었던 사고: 점수 91점이면 강도 10이 나오는데, 같은 종목이 과열 판정으로
  // action="관망"이 되면 화면에 "매수 강도 10/10 — 진입 신호 충족"과
  // "지금은 추격 매수하지 마세요 (절대 금지)"가 나란히 떴다. 10종목 중 5종목에서 재현됐다.
  // 초보자는 큰 숫자를 먼저 믿고 산다.
  //
  // 원인은 강도를 종합 점수만으로 계산하고, 그 뒤 과열·변동성·상관한도·하루손실한도가
  // 진입을 막은 사실을 반영하지 않은 것이다. 엔진이 "사지 말라"고 결론냈으면
  // 강도도 진입 문턱(7) 아래여야 한다. 5점("보통 — 조건이 맞으면 검토할 만해요")으로 낮춰
  // "점수는 괜찮지만 지금은 아니다"라는 실제 상태를 그대로 전한다.
  // 원래 점수는 score(0~100)에 그대로 남아 있고, 막힌 이유는 warnings에 적힌다.
  const buyStrengthRaw = scoreToBuyStrength(score);
  const entryBlocked = !holding && action === "관망" && buyStrengthRaw >= 7;
  const buyStrength = entryBlocked ? 5 : buyStrengthRaw;
  const sellStrength = holding ? computeSellStrength({ price, stopPrice, targetPrice, score, pnlPct: pnlPct ?? 0, rsi14: ind.rsi14 }) : null;
  // 보유 중이라도 action이 "추가매수"(피라미딩)면 매도가 아니라 "추가로 얼마나 강하게 사야 하는지"를 보여줘야 한다.
  const actionSummary =
    holding && action !== "추가매수"
      ? sellStrengthSummary(sellStrength as number, stopPrice, targetPrice)
      : buyStrengthSummary(buyStrength, price, entryBlocked, score);
  const verdict = buildVerdict({ held: Boolean(holding), action, buyStrength, sellStrength, reasons, warnings, overheated: overheatedNow, entryBlocked });

  // 예상 경로(차트용) — 조회 시점부터 마감까지 + D+1/D+2의 확률 구간.
  // 방향성은 과거 같은 국면의 5일 중앙값을 하루치로 환산한 값만(±0.5% 제한) 반영한다.
  // 순수 파생 데이터라 Claude 프롬프트에는 넣지 않는다(토큰 0).
  // data/scenarios.json은 국내 반도체 5종목만으로 만든 표다. 다른 업종에 적용하면
  // "과거 같은 국면"이라는 전제가 성립하지 않으므로 방향성을 0(제자리)으로 둔다.
  const scenarioDrift =
    params.scenarioTable && isSemiconductor(ticker)
      ? driftFromScenario(computeScenarioOutlook(candles, params.scenarioTable).d5?.median)
      : 0;
  const forecastPath = buildForecastPath(
    price,
    volForecast.available ? volForecast : null,
    kstMinutesNow(),
    STOCKS[ticker].market === "KR",
    scenarioDrift,
    !marketPhase.phase.startsWith("휴장"), // 주말·공휴일엔 장중 구간을 그리지 않는다
  );

  // 국면별 실측 상승률 — 반도체 5종목으로 만든 표라 그 종목에만 적용한다.
  // (비반도체는 히스토리가 쌓인 뒤 같은 방식으로 재검증해야 한다)
  const up = isSemiconductor(ticker) ? computeUpRate(candles) : null;

  // 오늘 체결이 가능한 가격 범위 — 상한가·하한가와 정적VI(전일 종가 ±10%) 발동가.
  // 국내 시장은 특정 가격에 닿으면 거래 방식이 바뀌는데(2분 단일가), 초보자는 이걸 모르고
  // "왜 체결이 안 되지"를 겪는다. 전일 종가를 모르면 조용히 생략된다.
  const priceLimits = currency === "KRW" ? computePriceLimits(params.prevClose ?? null, price) : null;

  // 파생 가격 최종 검문 — 실제 주문에 쓰이는 값이라 "이상하면 숨긴다"가 원칙이다.
  //
  // 왜 필요한가: 외부 시세 API가 잘못된 현재가(파싱 실패, 0, 캔들 이력과 자릿수가 다른 값)를
  // 돌려주면 ATR 기반 손절·목표가가 음수나 NaN으로 나온다. 그대로 내보내면 화면에
  // "손절 -35,062원" 같은 값이 뜨고, 초보 사용자는 그 숫자로 실제 주문을 넣는다.
  // 계산 실패는 "값이 없다"로 표시하는 것이 틀린 값을 보여주는 것보다 항상 낫다.
  const sanePrice = (v: number | null): number | null => {
    if (v == null) return null;
    if (!Number.isFinite(v) || v <= 0) return null;
    // 현재가에서 배 이상 벌어진 값은 계산 근거(캔들)와 현재가가 어긋났다는 뜻이다
    if (Number.isFinite(price) && price > 0 && (v > price * 2 || v < price / 2)) return null;
    return v;
  };
  const safeTarget = sanePrice(targetPrice);
  const safeStop = sanePrice(stopPrice);
  const safeEntry = sanePrice(suggestedEntryPrice?.price ?? null);
  if ((targetPrice != null && safeTarget == null) || (stopPrice != null && safeStop == null)) {
    warnings.unshift(
      "시세 데이터가 불안정해 목표가·손절가를 계산하지 못했습니다. 이 종목은 증권사 앱에서 현재가를 직접 확인한 뒤 판단하세요.",
    );
  }

  return {
    ticker,
    name,
    action,
    score: Math.round(score),
    confidence,
    reasons,
    warnings,
    targetPrice: safeTarget,
    stopPrice: safeStop,
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
    watchOrderNote,
    relativeStrengthNote: params.relativeStrengthNote ?? null,
    estimatedRoundTripCostWon,
    entryBlocked,
    breakEvenPrice,
    priceLimits: priceLimits?.available ? priceLimits : null,
    backtest: params.backtest ?? null,
    buyStrength,
    sellStrength,
    actionSummary,
    verdict,
    macroScore: Math.round(mac.score),
    disclosures: params.disclosures ?? [],
    investorFlow: params.investorFlow ?? [],
    volForecast: volForecast.available ? volForecast : null,
    forecastPath: forecastPath.available ? forecastPath : null,
    upRate: up?.available
      ? { regime: up.regime, upRatePct: up.upRatePct, sampleN: up.sampleN, overallPct: up.overallPct, distinguishable: up.distinguishable, headline: up.headline }
      : null,
    suggestedEntryPrice: safeEntry,
    entryPriceBasis: safeEntry == null ? null : (suggestedEntryPrice?.basis ?? null),
  };
}

// 추적종목 전체 + 매크로를 종합한 "오늘의 매수 매력도" 마스터 스코어.
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

// 그룹(예: 국내 반도체 / 해외 반도체) 내 상대강도 순위 — 단타에서는 "가장 강한 놈"을 골라 타는 게 원칙.
// 서로 다른 통화·거래시간대인 국내/미국 종목을 같은 등락률 랭킹에 섞으면(원화 vs 달러, 장 시간대도 다름)
// 의미 없는 비교가 되므로, 호출부에서 그룹별로 나눠 각각 이 함수를 호출한다.
export function computeRelativeStrength(
  stocks: { ticker: StockTicker; changePct: number }[],
  groupLabel: string = "추적",
): { ranked: RankedStock[]; noteFor: (ticker: StockTicker) => string; summary: string } {
  const ranked: RankedStock[] = [...stocks]
    .sort((a, b) => b.changePct - a.changePct)
    .map((s, i) => ({ ticker: s.ticker, name: STOCKS[s.ticker].name, changePct: s.changePct, rank: i + 1 }));
  const total = ranked.length;

  const noteFor = (ticker: StockTicker): string => {
    const r = ranked.find((x) => x.ticker === ticker);
    if (!r || total < 2) return "";
    const pctStr = `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`;
    if (r.rank === 1) return `${groupLabel} ${total}종목 중 등락률 1위(${pctStr}) — 오늘 가장 강한 종목, 단타 우선순위 상위`;
    if (r.rank === total) return `${groupLabel} ${total}종목 중 등락률 최하위(${pctStr}) — 상대적으로 약세, 진입 시 더 보수적으로 접근`;
    return `${groupLabel} ${total}종목 중 ${r.rank}위(${pctStr})`;
  };

  const summary =
    total >= 2
      ? `${groupLabel} 순위: ${ranked.map((r) => `${r.name} ${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`).join(" > ")}`
      : "";

  return { ranked, noteFor, summary };
}

// 섹터 집중도 점검 — 국내 반도체 5종목과 해외 반도체(엔비디아)는 통화·거래소는 다르지만
// 결국 같은 반도체 섹터로 묶이므로, 여러 종목에 나눠 담아도 분산투자로 착각하게 두지 않고
// 명시적으로 경고한다. 통화가 섞여 있으므로 usdKrwRate로 원화 환산해 비교한다.
export function computeSectorConcentration(
  holdings: Portfolio["holdings"],
  quotes: Record<string, { price: number } | null | undefined>,
  totalAssetKrw: number,
  usdKrwRate: number | null,
): { pct: number; warning: string | null } {
  if (totalAssetKrw <= 0) return { pct: 0, warning: null };
  const toKrw = (value: number, currency: "KRW" | "USD") => (currency === "USD" && usdKrwRate ? value * usdKrwRate : value);

  let semiValue = 0;
  let otherValue = 0;
  const sectorValue: Record<string, number> = {};
  for (const h of holdings) {
    const q = quotes[h.ticker];
    const stock = STOCKS[h.ticker];
    if (!stock) continue;
    const value = toKrw(h.qty * (q?.price ?? h.avgPrice), stock.currency);
    if (isSemiconductor(h.ticker)) semiValue += value;
    else otherValue += value;
    sectorValue[stock.sector] = (sectorValue[stock.sector] ?? 0) + value;
  }
  const combinedValue = semiValue + otherValue;
  const pct = (combinedValue / totalAssetKrw) * 100;
  const semiPct = (semiValue / totalAssetKrw) * 100;

  const parts: string[] = [];
  // 반도체 5종목은 서로 상관 0.7~0.9라 사실상 한 종목이다 — 합산 비중으로 경고한다
  if (semiPct >= 60) parts.push(`반도체 업종에 ${semiPct.toFixed(0)}%`);
  // 비반도체라도 한 업종에 몰리면 같은 문제 (예: 방산 한 종목에 70%)
  for (const [sector, v] of Object.entries(sectorValue)) {
    if (sector === "반도체") continue;
    const p = (v / totalAssetKrw) * 100;
    if (p >= 50) parts.push(`${sector} 업종에 ${p.toFixed(0)}%`);
  }

  if (parts.length > 0) {
    return {
      pct,
      warning:
        `보유 자산 중 ${parts.join(", ")}가 집중되어 있습니다 — 같은 업종 종목은 업황이 흔들리면 함께 움직이므로 ` +
        `종목 수를 늘렸다고 분산됐다고 보면 안 됩니다. 전체 포지션 크기를 재고하세요.`,
    };
  }
  return { pct, warning: null };
}
