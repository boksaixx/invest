// 천재(공격) 모드 — 하루 1~2회 공격적 눌림목 트레이드 셋업 생성기.
//
// 정직한 전제 (scripts/validate-modes.ts 로 재현 가능):
//  - "매일 최소 5% 수익"을 보장하는 규칙은 존재하지 않는다. 5개년 실데이터로 확인한 사실:
//    · 최근 6개월 급변동장에서는 5종목 중 1종목 이상이 하루 5%+ 고저범위를 보인 날이 96%
//      → "기회"는 거의 매일 존재한다.
//    · 그러나 순진한 추격 전략(변동성 1위를 시가 매수)은 같은 기간 -54% — 기회가 있어도
//      추격하면 갭 비용과 되돌림에 다 뺏긴다.
//    · 고정 % 파라미터 최적화는 학습 +36% → 검증 -5.5%로 뒤집힘(과적합).
//  - 유일하게 네 구간(급변동 전/후반, 2025, 평온한 2024) 모두 플러스였던 방식:
//    σ(당일 변동성 추정) 비례 눌림목 지정가 매수 + σ비례 익절/손절 + 폭락 직후 제외 필터.
//    변동성이 크면 목표·손절이 자동으로 커지고(지금 같은 장에선 목표 +5~9%),
//    평온장에선 자동으로 작아진다(+1~2%) — "매일 5%"가 아니라 "장세가 주는 만큼"이 정직하다.
import type { Candle, GeniusPlan, GeniusSetup, Quote, StockTicker, VolForecast } from "./types";
import { STOCKS } from "./types";

// σ비례 파라미터 — 그리드 최적화가 아니라 선험적 설계값(0.6/1.0/0.8)을 네 구간 검증으로 채택.
// 바꾸려면 반드시 scripts/validate-modes.ts 를 다시 돌려 네 구간 모두 견디는지 확인할 것.
export const GENIUS_DIP_SIGMA = 0.6; // 진입: 기준가 - 0.6σ 지정가
export const GENIUS_TARGET_SIGMA = 1.0; // 익절: 진입가 + 1.0σ
export const GENIUS_STOP_SIGMA = 0.8; // 손절: 진입가 - 0.8σ
export const GENIUS_RISK_PER_TRADE = 0.02; // 1회 리스크 = 총자산의 2% (일반 모드 1%의 2배)
export const GENIUS_MAX_TRADES = 2;

// 하루 고저 범위 기대값 ≈ 1.6σ (기하브라운운동의 Parkinson 관계식 sqrt(8/π)≈1.596 —
// 실측 데이터에서도 비슷한 배율이 확인됨). "오늘 5% 기회가 실재하는가"의 판단 기준.
const RANGE_PER_SIGMA = 1.6;

export function computeGeniusPlan(
  stocks: {
    ticker: StockTicker;
    quote: Quote | null;
    candles: Candle[];
    volForecast: VolForecast | null;
    engineScore: number; // runEngine 종합 점수 — 극단적 약세(30 미만) 종목은 눌림목 후보에서 제외
  }[],
  totalAssetKrw: number,
): GeniusPlan {
  const candidates: { setup: GeniusSetup; sig: number }[] = [];
  const skipped: string[] = [];

  for (const s of stocks) {
    const vf = s.volForecast;
    if (!s.quote || !vf?.available || s.candles.length < 3) continue;
    const name = STOCKS[s.ticker].name;
    const currency = STOCKS[s.ticker].currency;

    // 폭락 직후 제외 필터 (검증됨): 전일 -8% 이상, 또는 2일 연속 -5% 이상이면 "떨어지는 칼날" —
    // 눌림목 매수의 전제(정상 범위 내 되돌림)가 깨진 상태라 제외한다.
    const c = s.candles;
    const last = c[c.length - 1];
    const prev = c[c.length - 2];
    const prev2 = c[c.length - 3];
    const r1 = prev.close > 0 ? (last.close / prev.close - 1) * 100 : 0;
    const r2 = prev2.close > 0 ? (prev.close / prev2.close - 1) * 100 : 0;
    if (r1 <= -8 || (r1 <= -5 && r2 <= -5)) {
      skipped.push(`${name}(전일 ${r1.toFixed(1)}% 급락 — 칼날 잡기 금지)`);
      continue;
    }
    // 상한가 부근(당일 +29.5%↑)은 더 오를 여지가 없어 제외
    if (s.quote.changePct >= 29.5) {
      skipped.push(`${name}(상한가 도달)`);
      continue;
    }
    // 엔진 종합 점수가 극단적 약세면 제외 — 뉴스/수급/매크로가 무너진 종목의 눌림목은 함정일 확률이 높다
    if (s.engineScore < 30) {
      skipped.push(`${name}(종합점수 ${s.engineScore} — 약세 과다)`);
      continue;
    }

    const sigma = vf.sigmaDailyPct;
    const base = s.quote.price; // 장중엔 현재가 기준(시가 기준 셋업은 장전에만 의미)
    const entry = round(base * (1 - (GENIUS_DIP_SIGMA * sigma) / 100), currency);
    const target = round(entry * (1 + (GENIUS_TARGET_SIGMA * sigma) / 100), currency);
    const stop = round(entry * (1 - (GENIUS_STOP_SIGMA * sigma) / 100), currency);
    const expectedRange = RANGE_PER_SIGMA * sigma;

    // 리스크 기반 수량: 총자산 2% ÷ 손절폭. 원화 종목만 원화 총자산으로 계산(달러 종목은 수량 생략).
    let qty: number | null = null;
    let budget: number | null = null;
    if (currency === "KRW" && totalAssetKrw > 0 && entry > stop) {
      const riskAmount = totalAssetKrw * GENIUS_RISK_PER_TRADE;
      qty = Math.max(1, Math.floor(riskAmount / (entry - stop)));
      // 안전 상한: 한 트레이드가 총자산의 40%를 넘지 않게
      const maxQty = Math.floor((totalAssetKrw * 0.4) / entry);
      qty = Math.min(qty, Math.max(1, maxQty));
      budget = qty * entry;
    }

    const cautions: string[] = [];
    if (expectedRange < 5) {
      cautions.push(`오늘 예상 변동폭 ${expectedRange.toFixed(1)}% — 5% 기회가 크지 않은 날, 목표를 낮춰 잡았습니다`);
    }
    if (vf.regime === "극단") {
      cautions.push("변동성 극단 국면 — 손절가는 예외 없이, 체결 즉시 예약 걸어두세요");
    }

    candidates.push({
      setup: {
        ticker: s.ticker,
        name,
        currency,
        currentPrice: base,
        entryPrice: entry,
        targetPrice: target,
        stopPrice: stop,
        sigmaDailyPct: sigma,
        expectedRangePct: expectedRange,
        bigMoveLikely: expectedRange >= 5,
        suggestedQty: qty,
        suggestedBudget: budget,
        rationale: `변동성 ${vf.regime}(하루 ±${sigma.toFixed(1)}%) — 현재가 대비 -${(GENIUS_DIP_SIGMA * sigma).toFixed(1)}% 눌림에 지정가를 걸고, 체결되면 +${(GENIUS_TARGET_SIGMA * sigma).toFixed(1)}% 익절 / -${(GENIUS_STOP_SIGMA * sigma).toFixed(1)}% 손절`,
        cautions,
      },
      sig: sigma,
    });
  }

  // 변동성 높은 순으로 상위 2개 — 변동성이 클수록 눌림목-되돌림 폭이 커서 기대수익이 크다
  candidates.sort((a, b) => b.sig - a.sig);
  const setups = candidates.slice(0, GENIUS_MAX_TRADES).map((x) => x.setup);

  const maxRange = candidates.length ? Math.max(...candidates.map((x) => x.sig * RANGE_PER_SIGMA)) : 0;
  const marketNote =
    setups.length === 0
      ? "오늘은 조건을 만족하는 셋업이 없습니다 — 억지로 만들지 않는 것이 이 모드의 원칙입니다."
      : maxRange >= 5
        ? `오늘 최대 예상 변동폭 ${maxRange.toFixed(1)}% — 5% 이상 기회가 실재하는 날입니다. 단, 지정가 미체결이면 그날 트레이드는 없습니다(추격 금지).`
        : `오늘 최대 예상 변동폭 ${maxRange.toFixed(1)}% — 큰 기회는 없는 날이라 목표를 변동성에 맞춰 낮췄습니다.`;

  return {
    available: true,
    setups,
    marketNote,
    skippedNote: skipped.length ? `제외: ${skipped.join(", ")}` : null,
  };
}

// 한국 주식 호가단위에 맞춰 반올림(간이) — 달러 종목은 센트 단위
function round(price: number, currency: "KRW" | "USD"): number {
  if (currency === "USD") return Math.round(price * 100) / 100;
  const tick = price >= 500_000 ? 1000 : price >= 200_000 ? 500 : price >= 50_000 ? 100 : price >= 20_000 ? 50 : price >= 5_000 ? 10 : price >= 2_000 ? 5 : 1;
  return Math.round(price / tick) * tick;
}
