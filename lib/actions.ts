// 화면이 따를 "최종 행동"을 한 곳에서 정한다 — 오늘 나의 행동 카드, 비서 브리핑, 계좌 리포트, 종목 카드가
// 전부 이 규칙을 공유한다. 예전에는 page.tsx 안 IIFE에 묻혀 있어 브리핑이 같은 결론을 낼 방법이 없었다.
import type { AiAdvice, EngineSignal, Portfolio, Quote, TodayTrade } from "./types";
import { STOCKS } from "./types";

/** "실제로 보유 중"의 단 하나의 정의 — 수량과 평단가가 모두 있어야 한다. 서버(normalizePortfolio)와 같은 기준. */
export function isHeld(h: { qty: number; avgPrice: number } | undefined | null): h is { qty: number; avgPrice: number } {
  return Boolean(h && h.qty > 0 && h.avgPrice > 0);
}

/**
 * AI 판단을 우선하되, 엔진이 진입을 막은 종목(entryBlocked)에 AI가 매수를 내면 엔진 판단으로 되돌린다.
 * 서버(lib/claude.ts applyConsistencyCheck)도 같은 보정을 하지만, 예전 캐시 결과와 "AI 없이 엔진만" 경로까지
 * 한 규칙으로 묶기 위해 화면에서도 한 번 더 건다.
 */
export function effectiveAction(sig: EngineSignal | undefined, ai: AiAdvice["stocks"][number] | undefined): string | undefined {
  const a = ai?.action ?? sig?.action;
  if (sig?.entryBlocked && (a === "신규매수" || a === "추가매수")) return sig.action;
  return a;
}

/** 가격 표기의 마지막 방어선 — 음수·NaN·Infinity는 "-"로. 국내는 "12,345원", 달러는 "$123.45". */
export function fmtPrice(n: number | null | undefined, currency: "KRW" | "USD"): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "-";
  if (currency === "USD") return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${Math.round(n).toLocaleString("ko-KR")}원`;
}

export type DoitKind = "sell" | "buy" | "limit" | "hold" | "avoid" | "wait";
export interface DoitRow {
  rank: number; // 낮을수록 먼저 (0 = 지금 팔 것)
  kind: DoitKind;
  ticker: string;
  name: string;
  verb: string; // "지금 파세요" 같은 한 마디
  detail: string; // 얼마에·얼마나·어디서 자를지
}

export interface DoitInput {
  signals: EngineSignal[];
  advice: AiAdvice | null | undefined;
  // 화면의 응답 타입은 ticker가 string이라 구조적으로 느슨하게 받는다
  todayPlan?: { trades: { ticker: string; kind: TodayTrade["kind"] | string; entryPrice: number | null; targetPrice: number | null; stopPrice: number | null; suggestedQty: number | null }[] } | null;
}

/**
 * "오늘 나의 행동" 행 목록 — 팔 것 → 살 것 → 지정가 걸 것 → 들고 있을 것 → 안 건드릴 것 순.
 * 매도 문구는 반드시 실제 보유 중일 때만 낸다(미보유 + 매도신호 = "사지 마세요").
 */
export function buildDoitRows(result: DoitInput, portfolio: Portfolio, quotes: Record<string, Quote | null> | null | undefined): DoitRow[] {
  const rows: DoitRow[] = result.signals.map((sg) => {
    const ai = result.advice?.stocks.find((x) => x.ticker === sg.ticker || x.ticker.includes(sg.ticker));
    const act = (effectiveAction(sg, ai) ?? sg.action) as string;
    const hold = portfolio.holdings.find((x) => x.ticker === sg.ticker && isHeld(x));
    const cur = STOCKS[sg.ticker].currency;
    const px = (v: number | null | undefined) => (v == null ? "" : fmtPrice(v, cur));
    // 행의 "지금 가격"은 60초마다 갱신되는 시세 — 분석 시점 가격에 묶어두면 몇 시간 전 값이 "지금"으로 읽힌다
    const livePrice = quotes?.[sg.ticker]?.price ?? sg.price;
    const lv = sg.forecastPath?.orderLevels;
    const base = { ticker: sg.ticker, name: sg.name };
    const isSell = act === "손절" || act === "전량매도" || act === "부분매도";
    if (isSell && hold) {
      if (act === "부분매도") {
        // 단타 청산(1σ 익절·VWAP 이탈·마감 전 청산)은 "지금 시장가로 절반". "절반" 수량은 분할 매도 계획 1차와 같은 숫자.
        const half = sg.scaledExit[0]?.qty ?? Math.ceil(hold.qty / 2);
        const cause = (sg.reasons[0] ?? "").split(" — ")[0];
        const atTarget = /목표가.*도달/.test(cause);
        const target = ai?.targetPrice ?? sg.targetPrice;
        return {
          ...base, rank: 1, kind: "sell", verb: "절반 파세요",
          detail: atTarget && target != null
            ? `보유 ${hold.qty}주 중 ${half}주 · ${px(target)} 부근`
            : `보유 ${hold.qty}주 중 ${half}주 · 지금 ${px(livePrice)} 부근에서${cause ? ` · ${cause.length > 44 ? `${cause.slice(0, 44)}…` : cause}` : ""}`,
        };
      }
      return { ...base, rank: 0, kind: "sell", verb: "지금 파세요", detail: `보유 ${hold.qty}주 전량 · ${px(ai?.stopPrice ?? sg.stopPrice)} 아래면 즉시` };
    }
    if (isSell) return { ...base, rank: 5, kind: "avoid", verb: "사지 마세요", detail: "떨어지는 흐름이라 지금 새로 들어갈 자리가 아닙니다 (보유분 없음)" };
    if (act === "신규매수" || act === "추가매수") {
      // 수량은 엔진이 "엔진 손절폭" 기준 1% 리스크로 낸 값 — 이 행의 손절가도 엔진 값을 써야 수량과 맞는다
      const qty = sg.suggestedQty && sg.suggestedQty > 0 ? `${sg.suggestedQty}주` : "수량은 종목 탭 참고";
      return { ...base, rank: 2, kind: "buy", verb: hold ? "더 사세요" : "사세요", detail: `${px(ai?.entryPrice ?? sg.suggestedEntryPrice)} · ${qty} · 손절 ${px(sg.stopPrice)}` };
    }
    if (hold) {
      const exit1 = sg.scaledExit[0];
      return {
        ...base, rank: 4, kind: "hold", verb: "그대로 두세요",
        detail: `보유 ${hold.qty}주 · ${px(ai?.stopPrice ?? sg.stopPrice)} 깨지면 파세요${exit1 ? ` · ${px(exit1.price)} 닿고 꺾이면 절반 익절` : ""}`,
      };
    }
    // 미보유 관망 — "기다리세요"로 끝내지 않는다. ① 검증된 눌림목(있을 때만) ② 엔진 대기 매수가(점수 58+) ③ 도달확률 지정가
    const dip = result.todayPlan?.trades.find((t) => t.ticker === sg.ticker && t.kind === "눌림목매수" && t.entryPrice != null);
    if (dip) {
      return {
        ...base, rank: 3, kind: "limit", verb: "지정가 걸어두세요",
        detail: `${px(dip.entryPrice)} 매수 대기${dip.suggestedQty ? ` · ${dip.suggestedQty}주` : ""} · 익절 ${px(dip.targetPrice)} / 손절 ${px(dip.stopPrice)} · 미체결이면 오늘은 없음`,
      };
    }
    if (sg.suggestedEntryPrice != null && sg.score >= 58) {
      return {
        ...base, rank: 3, kind: "limit", verb: "지정가 걸어두세요",
        detail: `${px(ai?.entryPrice ?? sg.suggestedEntryPrice)} 매수 대기 · 손절 ${px(ai?.stopPrice ?? sg.stopPrice)} · ${(sg.entryPriceBasis ?? "").split(" — ")[0].slice(0, 40)}`,
      };
    }
    return { ...base, rank: 6, kind: "wait", verb: "기다리세요", detail: lv ? `${px(lv.buyPrice)}까지 내려오면 그때 검토 (오늘 닿을 확률 ${lv.buyProbPct}%)` : "지금은 살 이유가 없습니다" };
  });
  // 보유 중인데 시세·캔들 수집 실패로 신호가 안 나온 종목 — 행이 없으면 "괜찮다"로 읽힌다. 반드시 알린다.
  for (const h of portfolio.holdings) {
    if (!isHeld(h) || result.signals.some((s) => s.ticker === h.ticker)) continue;
    rows.push({ ticker: h.ticker, name: STOCKS[h.ticker].name, rank: 0, kind: "hold", verb: "데이터 없음", detail: `보유 ${h.qty}주 · 이번 분석에서 시세를 못 가져왔어요 — 증권사 앱에서 직접 확인하세요` });
  }
  return rows.sort((a, b) => a.rank - b.rank);
}
