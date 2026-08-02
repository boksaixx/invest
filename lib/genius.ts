// 오늘의 작전 — 장세(레짐)를 엔진이 스스로 판별해 그날 유효한 플레이북을 제시한다.
// (구 "천재 모드"를 대체: 모드를 사람이 토글로 고르는 게 아니라, 폭락장/급등과열/변동성확대/보통을
//  데이터로 판별해 자동으로 작전을 바꾼다 — 목적은 모드 구분이 아니라 "이 장에서 수익"이므로.)
//
// 정직한 전제 (scripts/validate-modes.ts 로 재현 가능):
//  - "매일 최소 5% 수익"을 보장하는 규칙은 존재하지 않는다. 아래 플레이북들은 각 장세에서
//    통계적 우위가 실측된 규칙일 뿐이며, 우위가 없는 날은 "오늘은 없음"이 정답이다.
//  - 눌림목매수(변동성확대/보통): σ비례 지정가(-0.6σ/+1.0σ/-0.8σ) — 급변동 전/후반·2025·평온한
//    2024 네 구간 모두 거래비용 차감 후 플러스 (+21.0/+7.1/+4.3/+10.7%).
//  - 폭락반등매수(폭락장): 당일 -7%↓ 종목 마감 동시호가 소액 매수 → 익일 종가 청산.
//    실측 익일 평균 +1.4%(급변동장 +2.1%), 승률 64~65%. 익절/손절 변형은 급변동장에서 오히려
//    성과를 망쳐(수익 상한만 막고 하방은 다 맞음) 쓰지 않는다. 대신 13.6% 확률의 "연속 폭락"
//    꼬리를 소액(총자산 10% 이내)으로 감당한다.
//  - 급등익절(급등과열): +12%↑ 급등 보유 종목은 익일 시가 투매 대신 전일종가 +3% 지정가 분할
//    매도. 실측 익일 고가 +3% 도달 64%, 고가 평균 +5.4% — 단 갭하락 출발도 42%라 전량 홀드 금물.
//  - SOX 폭락 아침의 보유자: 시가 패닉 매도 후 재매수는 그냥 보유 대비 평균 -0.13%p로 무익.
//    갭(-2.4%)에 낙폭이 이미 반영돼 있어 시가 투매는 손실 확정일 뿐이다.
import type { Candle, HoldEdge, Holding, MarketRegime, Quote, StockTicker, TodayPlan, TodayTrade, VolForecast } from "./types";
import { computeScenarioOutlook, type PlaybookStats, type ScenarioTable } from "./scenario";
import { isSemiconductor, STOCKS } from "./types";

// σ비례 눌림목 파라미터 — 그리드 최적화가 아니라 선험적 설계값(0.6/1.0/0.8)을 네 구간 검증으로 채택.
// 바꾸려면 반드시 scripts/validate-modes.ts 를 다시 돌려 네 구간 모두 견디는지 확인할 것.
export const GENIUS_DIP_SIGMA = 0.6;
export const GENIUS_TARGET_SIGMA = 1.0;
export const GENIUS_STOP_SIGMA = 0.8;
export const GENIUS_RISK_PER_TRADE = 0.02; // 눌림목 1회 리스크 = 총자산의 2%
export const GENIUS_MAX_TRADES = 2;
export const CRASH_REBOUND_MAX_WEIGHT = 0.1;
// 폭락 반등 규칙의 진입 임계값 — 엔진과 검증 스크립트가 반드시 같은 값을 쓰도록 여기서 한 번만 정의한다.
// (과거에 엔진 -7% / 검증 -8%로 어긋나 "검증되지 않은 조건으로 매수를 제안"하는 상태가 있었다.)
export const CRASH_REBOUND_THRESHOLD_PCT = -7; // 폭락반등은 총자산 10% 이내 소액 (연속 폭락 13.6% 대비)

const RANGE_PER_SIGMA = 1.6; // 하루 고저범위 기대값 ≈ 1.6σ (Parkinson 관계식, 실측 부합)

/**
 * 보유 대 트레이딩 우열 분해 — 최근 120거래일 수익을 "오버나이트 갭"과 "장중"으로 나눈다.
 *
 * 검증으로 확인한 사실(scripts/validate-holding.ts): 최근 6개월 삼성전자는 전체 +71.3% 중
 * 오버나이트 갭이 +71.1%, 장중은 +0.1%였다. 매일 종가 청산하는 단타 규칙은 갭 수익에
 * 접근할 수 없어 같은 구간 단순 보유(+74%)에 크게 뒤졌다(-13%). 예측이 아니라 과거 사실이며,
 * 사용자가 "지금 이 국면에서 사고팔기가 유리한가"를 스스로 판단할 근거로 쓴다.
 */
export function computeHoldEdge(candles: Candle[]): HoldEdge {
  const empty: HoldEdge = { available: false, overnightPct: 0, intradayPct: 0, totalPct: 0, verdict: "혼재", note: "" };
  if (candles.length < 60) return empty;
  const w = candles.slice(-121);
  let gap = 1;
  let intra = 1;
  let tot = 1;
  for (let i = 1; i < w.length; i++) {
    const p = w[i - 1];
    const x = w[i];
    if (!(p.close > 0 && x.open > 0 && x.close > 0)) continue;
    gap *= x.open / p.close;
    intra *= x.close / x.open;
    tot *= x.close / p.close;
  }
  const overnightPct = (gap - 1) * 100;
  const intradayPct = (intra - 1) * 100;
  const totalPct = (tot - 1) * 100;

  // 낙폭 인지 — 여기가 핵심이다.
  // 이 지표는 "지난 6개월 동안" 무엇이 유리했는지를 재는 후행 지표다. 그런데 그 6개월에
  // 대세 상승장이 들어 있고 지금은 이미 고점 대비 크게 무너진 상태라면, 그 평균을 근거로
  // "보유가 유리하다"고 말하는 순간 정확히 반대로 조언하게 된다.
  // (실제 사례: 2026-07 기준 삼성전기는 6개월 누적으론 플러스였지만 고점 대비 -61%였다.)
  // 그래서 고점 대비 15% 이상 무너진 상태에서는 "보유우위" 판정을 내지 않는다.
  const recent = candles.slice(-60);
  const high60 = Math.max(...recent.map((c) => c.close));
  const lastClose = candles[candles.length - 1].close;
  const drawdownPct = high60 > 0 ? (lastClose / high60 - 1) * 100 : 0;
  const trendBroken = drawdownPct <= -15;

  const verdict: HoldEdge["verdict"] =
    trendBroken
      ? "혼재"
      : totalPct > 5 && overnightPct > intradayPct * 2 && overnightPct > 5
        ? "보유우위"
        : intradayPct > overnightPct * 2 && intradayPct > 5
          ? "장중우위"
          : "혼재";

  const note = trendBroken
    ? `최근 6개월 누적으로는 갭 ${overnightPct.toFixed(0)}%p / 장중 ${intradayPct.toFixed(0)}%p였지만, 지금은 60일 고점 대비 ${drawdownPct.toFixed(0)}%까지 무너진 상태입니다. 그 누적 수치는 이미 끝난 상승 구간이 만든 것이라 지금 국면에 그대로 적용할 수 없습니다 — "그동안 올랐으니 들고 있으면 된다"는 판단은 금물입니다.`
    : verdict === "보유우위"
      ? `최근 6개월 이 종목 수익은 대부분 밤사이 갭에서 나왔습니다(전체 ${totalPct.toFixed(0)}% 중 갭 ${overnightPct.toFixed(0)}%p, 장중 ${intradayPct.toFixed(0)}%p). 매일 종가에 파는 단타는 이 수익을 못 가져가니, 이 구간에선 들고 가는 쪽이 유리했습니다. 다만 이는 후행 지표이니 추세가 깨지면 즉시 무효입니다.`
      : verdict === "장중우위"
        ? `최근 6개월 수익이 주로 장중에서 나왔습니다(장중 ${intradayPct.toFixed(0)}%p vs 갭 ${overnightPct.toFixed(0)}%p) — 단타가 상대적으로 유리했던 구간입니다.`
        : `최근 6개월 갭 ${overnightPct.toFixed(0)}%p / 장중 ${intradayPct.toFixed(0)}%p — 어느 쪽이 낫다고 단정하기 어려운 구간입니다.`;
  return { available: true, overnightPct, intradayPct, totalPct, verdict, note };
}

export function computeTodayPlan(
  stocks: {
    ticker: StockTicker;
    quote: Quote | null;
    candles: Candle[];
    volForecast: VolForecast | null;
    engineScore: number;
  }[],
  totalAssetKrw: number,
  holdings: Holding[],
  macro: { soxChangePct: number | null; kospiChangePct: number | null },
  scenarioTable?: ScenarioTable | null,
): TodayPlan {
  const heldTickers = new Set(holdings.filter((h) => h.qty > 0).map((h) => h.ticker));
  const pb: PlaybookStats | null = scenarioTable?.playbook ?? null;
  const skipped: string[] = [];
  const holderGuide: string[] = [];

  // ---------- 1) 레짐 판별 ----------
  const todayMoves = stocks
    .filter((s) => s.quote)
    .map((s) => ({ ticker: s.ticker, name: STOCKS[s.ticker].name, chg: s.quote!.changePct }));
  // 폭락반등·급등익절 플레이북의 실적 통계(n=127 등)는 국내 "반도체 5종목"으로만 실측한 값이다.
  // 방산·금융·바이오·통신은 폭락의 원인(임상 실패, 규제, 수주 취소)이 전혀 달라 같은 반등을
  // 기대할 근거가 없다. 검증된 종목에만 적용한다.
  const crashers = todayMoves.filter((m) => m.chg <= CRASH_REBOUND_THRESHOLD_PCT && isSemiconductor(m.ticker));
  const surgers = todayMoves.filter((m) => m.chg >= 12 && isSemiconductor(m.ticker));
  const soxCrash = macro.soxChangePct != null && macro.soxChangePct <= -3.5;
  const kospiCrash = macro.kospiChangePct != null && macro.kospiChangePct <= -3;
  const volRegimes = stocks.map((s) => s.volForecast).filter((v): v is VolForecast => Boolean(v?.available));
  const highVolCount = volRegimes.filter((v) => v.regime === "높음" || v.regime === "극단").length;

  let regime: MarketRegime;
  let regimeNote: string;
  if (crashers.length > 0 || soxCrash || kospiCrash) {
    regime = "폭락장";
    const causes: string[] = [];
    if (soxCrash) causes.push(`간밤 미 반도체지수(SOX) ${macro.soxChangePct!.toFixed(1)}% 폭락`);
    if (kospiCrash) causes.push(`코스피 ${macro.kospiChangePct!.toFixed(1)}% 급락`);
    if (crashers.length) causes.push(`${crashers.map((c) => `${c.name} ${c.chg.toFixed(1)}%`).join("·")} 폭락 중`);
    regimeNote = causes.join(", ");
  } else if (surgers.length > 0) {
    regime = "급등과열";
    regimeNote = `${surgers.map((s) => `${s.name} +${s.chg.toFixed(1)}%`).join("·")} 급등 중`;
  } else if (volRegimes.length > 0 && highVolCount >= Math.ceil(volRegimes.length / 2)) {
    regime = "변동성확대";
    regimeNote = `추적 종목 과반(${highVolCount}/${volRegimes.length})이 변동성 높음/극단 국면`;
  } else {
    regime = "보통";
    regimeNote = "특이 급변동 없음 — 평상시 원칙대로";
  }

  const trades: TodayTrade[] = [];

  // ---------- 2) 폭락장 플레이북 ----------
  if (regime === "폭락장") {
    // 보유자 지침 — 실측 근거를 그대로 인용한다
    if (soxCrash) {
      holderGuide.push(
        `갭하락 시가에 패닉 매도하지 마세요 — 5년 실측(간밤 SOX -3.5%↓였던 395일)상 낙폭은 갭(-2.4%)에 이미 반영돼 있고, 시가 매도 후 저가 재매수 시도는 그냥 보유 대비 평균 -0.13%p로 이득이 없었습니다. 손절선 원칙만 지키세요.`,
      );
    }
    holderGuide.push("기존 손절선은 예외 없이 지키되, 손절선 위라면 장중 투매에 휩쓸리지 말 것 — 계획에 없던 매도가 최악의 매도입니다.");

    // 폭락 반등 노림수: 지금 -7% 이상 빠진 종목 → 마감 동시호가 소액 매수
    for (const cr of crashers.slice(0, GENIUS_MAX_TRADES)) {
      const s = stocks.find((x) => x.ticker === cr.ticker)!;
      const price = s.quote!.price;
      const currency = STOCKS[cr.ticker].currency;
      if (currency !== "KRW") continue; // 동시호가 규칙은 국내장 기준 검증
      const maxBudget = totalAssetKrw * CRASH_REBOUND_MAX_WEIGHT;
      const qty = totalAssetKrw > 0 ? Math.max(1, Math.floor(maxBudget / price)) : null;
      trades.push({
        kind: "폭락반등매수",
        ticker: cr.ticker,
        name: cr.name,
        currency,
        currentPrice: price,
        entryPrice: price, // 동시호가 참고가 (실제 체결은 15:20~15:30 동시호가)
        targetPrice: null, // 목표가/손절가 없이 익일 종가 청산이 검증된 원형
        stopPrice: null,
        sellLimitPrice: null,
        sigmaDailyPct: s.volForecast?.sigmaDailyPct ?? NaN,
        suggestedQty: qty,
        suggestedBudget: qty != null ? qty * price : null,
        headline: `마감 동시호가(15:20~15:30) 소액 분할 매수 → 내일 종가 부근 청산`,
        rationale: pb
          ? `당일 ${cr.chg.toFixed(1)}% 폭락 — 5년 실측상 ${pb.crashRebound.thresholdPct}%↓ 폭락 마감 후 익일 수익률은 평균 ${pb.crashRebound.avgNextDay >= 0 ? "+" : ""}${pb.crashRebound.avgNextDay}%, 승률 ${pb.crashRebound.winRate}% (표본 ${pb.crashRebound.n}회, 거래비용 차감 후). 익절·손절을 미리 거는 변형은 검증에서 오히려 열위라 "익일 종가 청산" 원형 그대로 제안합니다.`
          : `당일 ${cr.chg.toFixed(1)}% 폭락 — 과거 통계 파일을 불러오지 못해 구체적 수치는 생략합니다.`,
        cautions: [
          `평균이 플러스여도 개별 사례의 편차가 큽니다 — 다음날 더 빠지는 경우도 흔하니 총자산의 ${CRASH_REBOUND_MAX_WEIGHT * 100}% 이내 소액만, 잃어도 계획이 안 무너지는 금액으로.`,
          "뉴스가 '개별 악재'(회계 문제, 대규모 소송 등)면 이 통계가 적용되지 않습니다 — 시장 전체 패닉일 때만 유효한 규칙입니다.",
        ],
      });
    }
    if (crashers.length === 0) {
      // SOX/코스피발 폭락장이지만 개별 종목은 -7% 미만 → 신규 진입 우위 없음
      skipped.push("갭에 낙폭이 이미 반영된 날은 장중 신규 매수 우위가 없습니다(실측 시가→종가 +0.27%, 시가-2% 눌림 체결 시 +0.06%) — 오늘 신규 진입 없음");
    }
  }

  // ---------- 3) 급등과열 플레이북 ----------
  if (regime === "급등과열") {
    for (const su of surgers.slice(0, GENIUS_MAX_TRADES)) {
      const s = stocks.find((x) => x.ticker === su.ticker)!;
      const price = s.quote!.price;
      const currency = STOCKS[su.ticker].currency;
      const held = heldTickers.has(su.ticker);
      if (held) {
        const limit = roundTick(price * 1.03, currency);
        const holdingQty = holdings.find((h) => h.ticker === su.ticker)?.qty ?? 0;
        trades.push({
          kind: "급등익절",
          ticker: su.ticker,
          name: su.name,
          currency,
          currentPrice: price,
          entryPrice: null,
          targetPrice: null,
          stopPrice: null,
          sellLimitPrice: limit,
          sigmaDailyPct: s.volForecast?.sigmaDailyPct ?? NaN,
          suggestedQty: Math.max(1, Math.floor(holdingQty / 2)),
          suggestedBudget: null,
          headline: `내일 아침 ${limit.toLocaleString()}${currency === "USD" ? "$" : "원"}에 절반 매도 지정가를 미리 걸어두세요`,
          rationale: pb
            ? `당일 +${su.chg.toFixed(1)}% 급등 — 5년 실측상 +${pb.surgeTakeProfit.thresholdPct}%↑ 급등 다음날 고가는 평균 +${pb.surgeTakeProfit.avgNextHigh}%였고, ${pb.surgeTakeProfit.hit3Pct}%의 날에 +3% 지정가가 체결됐습니다(표본 ${pb.surgeTakeProfit.n}회). 시가에 파는 것보다 장중 고점 지정가가 유리했습니다.`
            : `당일 +${su.chg.toFixed(1)}% 급등 — 과거 통계 파일을 불러오지 못해 구체적 수치는 생략합니다.`,
          cautions: [
            pb
              ? `갭하락 출발도 ${pb.surgeTakeProfit.gapDownPct}%나 됩니다 — 전량 홀드는 금물이고, 지정가 미체결 시 장 후반에 상황 보고 정리하세요.`
              : "갭하락 출발 가능성이 상당하니 전량 홀드는 금물입니다.",
          ],
        });
      } else {
        skipped.push(`${su.name}(+${su.chg.toFixed(1)}% 급등 — 미보유 추격 매수 금지)`);
      }
    }
    holderGuide.push("급등 종목을 오늘 더 사는 것(추격)은 금지 — 내일 익절 계획이 오늘의 숙제입니다.");
  }

  // ---------- 4) 눌림목 플레이북 (변동성확대/보통 — 폭락/급등 장이 아닐 때) ----------
  if (regime === "변동성확대" || regime === "보통") {
    const candidates: { setup: TodayTrade; sig: number }[] = [];
    for (const s of stocks) {
      const vf = s.volForecast;
      if (!s.quote || !vf?.available || s.candles.length < 3) continue;
      const name = STOCKS[s.ticker].name;
      const currency = STOCKS[s.ticker].currency;
      const c = s.candles;
      const last = c[c.length - 1];
      const prev = c[c.length - 2];
      const prev2 = c[c.length - 3];
      const r1 = prev.close > 0 ? (last.close / prev.close - 1) * 100 : 0;
      const r2 = prev2.close > 0 ? (prev.close / prev2.close - 1) * 100 : 0;
      // 전일 폭락 직후는 눌림목 후보에서 제외 — 어제 폭락했다면 "폭락반등" 보유분 청산일이지 신규 눌림목 날이 아니다
      if (r1 <= -8 || (r1 <= -5 && r2 <= -5)) {
        skipped.push(`${name}(전일 ${r1.toFixed(1)}% 급락 — 눌림목 아님)`);
        continue;
      }
      if (s.quote.changePct >= 29.5) {
        skipped.push(`${name}(상한가 도달)`);
        continue;
      }
      if (s.engineScore < 30) {
        skipped.push(`${name}(종합점수 ${s.engineScore} — 약세 과다)`);
        continue;
      }
      const sigma = vf.sigmaDailyPct;
      const base = s.quote.price;
      const entry = roundTick(base * (1 - (GENIUS_DIP_SIGMA * sigma) / 100), currency);
      const target = roundTick(entry * (1 + (GENIUS_TARGET_SIGMA * sigma) / 100), currency);
      const stop = roundTick(entry * (1 - (GENIUS_STOP_SIGMA * sigma) / 100), currency);
      let qty: number | null = null;
      let budget: number | null = null;
      if (currency === "KRW" && totalAssetKrw > 0 && entry > stop) {
        const riskAmount = totalAssetKrw * GENIUS_RISK_PER_TRADE;
        qty = Math.max(1, Math.floor(riskAmount / (entry - stop)));
        const maxQty = Math.floor((totalAssetKrw * 0.4) / entry);
        qty = Math.min(qty, Math.max(1, maxQty));
        budget = qty * entry;
      }
      const expectedRange = RANGE_PER_SIGMA * sigma;
      const cautions: string[] = [];
      if (vf.regime === "극단") cautions.push("변동성 극단 국면 — 체결 즉시 손절 예약까지 걸어두세요");
      candidates.push({
        setup: {
          kind: "눌림목매수",
          ticker: s.ticker,
          name,
          currency,
          currentPrice: base,
          entryPrice: entry,
          targetPrice: target,
          stopPrice: stop,
          sellLimitPrice: null,
          sigmaDailyPct: sigma,
          suggestedQty: qty,
          suggestedBudget: budget,
          headline: `${entry.toLocaleString()}${currency === "USD" ? "$" : "원"} 지정가 매수 대기 (미체결이면 오늘은 없음)`,
          rationale: `변동성 ${vf.regime}(하루 ±${sigma.toFixed(1)}%, 예상 고저폭 ${expectedRange.toFixed(1)}%) — 현재가 -${(GENIUS_DIP_SIGMA * sigma).toFixed(1)}% 눌림에 걸고, 체결되면 +${(GENIUS_TARGET_SIGMA * sigma).toFixed(1)}% 익절 / -${(GENIUS_STOP_SIGMA * sigma).toFixed(1)}% 손절.`,
          cautions,
        },
        sig: sigma,
      });
    }
    candidates.sort((a, b) => b.sig - a.sig);
    trades.push(...candidates.slice(0, GENIUS_MAX_TRADES).map((x) => x.setup));
    holderGuide.push("보유 종목은 각 카드의 손절선을 그대로 — 변동폭이 커질수록 손절을 미루려는 유혹도 커지니, 예약 주문으로 자동화해 두세요.");
  }

  // ---------- 5) 요약 문구 ----------
  const marketNote =
    regime === "폭락장"
      ? trades.length
        ? "폭락장 플레이북 — 반등 통계가 있는 자리만 소액으로 노리고, 나머지는 원칙 방어."
        : "폭락장 방어 모드 — 오늘은 지키는 날입니다. 통계적으로 신규 진입 우위가 없습니다."
      : regime === "급등과열"
        ? "급등 과열 — 오늘 살 자리가 아니라 내일 팔 자리를 준비하는 날입니다."
        : trades.length === 0
          ? "오늘은 조건을 만족하는 셋업이 없습니다 — 억지로 만들지 않는 것이 원칙입니다."
          : `오늘 최대 예상 변동폭 ${Math.max(...trades.map((t) => t.sigmaDailyPct * RANGE_PER_SIGMA)).toFixed(1)}% — 지정가 미체결이면 그날 트레이드는 없습니다(추격 금지).`;

  // 보유 vs 트레이딩 우열 — 거래대금이 가장 큰 대표 종목(삼성전자 우선) 기준으로 한 번만 계산
  const repr = stocks.find((s) => s.ticker === "005930") ?? stocks.find((s) => s.candles.length >= 60);
  const holdEdge = repr ? computeHoldEdge(repr.candles) : null;

  // 국면별 조건부 전망 — 종목마다 지금 어떤 국면이고 과거 같은 국면이 어떻게 흘렀는지.
  // "6개월 평균 수익률" 같은 뭉뚱그린 숫자 대신 조건부 분포를 쓴다.
  const scenarios = stocks
    .map((st) => {
      const o = computeScenarioOutlook(st.candles, scenarioTable ?? null);
      return o.available
        ? { name: STOCKS[st.ticker].name, label: o.label, note: o.note, lowConfidence: o.lowConfidence }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
  if (holdEdge?.available && holdEdge.verdict === "보유우위") {
    holderGuide.unshift(holdEdge.note);
    // 단타 셋업이 있는데 보유가 유리했던 국면이면, 그 사실을 셋업 자체에 경고로 붙인다
    for (const t of trades) {
      if (t.kind === "눌림목매수") {
        t.cautions.push("최근 이 종목은 사고파는 것보다 들고 있는 편이 유리했습니다 — 이 셋업은 소액으로만, 보유 물량을 팔아서 하지는 마세요.");
      }
    }
  }

  return {
    regime,
    regimeNote,
    trades,
    holderGuide,
    marketNote,
    skippedNote: skipped.length ? `제외: ${skipped.join(", ")}` : null,
    holdEdge,
    scenarios,
  };
}

// 한국 주식 호가단위 반올림(간이) — 달러 종목은 센트 단위
function roundTick(price: number, currency: "KRW" | "USD"): number {
  if (currency === "USD") return Math.round(price * 100) / 100;
  const tick = price >= 500_000 ? 1000 : price >= 200_000 ? 500 : price >= 50_000 ? 100 : price >= 20_000 ? 50 : price >= 5_000 ? 10 : price >= 2_000 ? 5 : 1;
  return Math.round(price / tick) * tick;
}
