// 계좌 단위 하루 리스크 — "오늘 여기서 멈춰야 하는가"를 판단한다.
//
// 왜 만들었나: 이 앱에는 "1회 매매 리스크 = 총자산의 1%"라는 건별 한도만 있었다.
// 종목별로는 원칙을 지켜도 같은 날 여러 종목이 동시에 무너지면 계좌 전체가 크게 빠진다 —
// 반도체 5종목의 상관은 최근 6개월 0.89로, 사실상 한 종목에 몰아넣은 것과 같다.
// 프로 트레이딩 데스크가 예외 없이 두는 장치가 "데일리 스톱"인데 여기에는 없었다.
//
// 실측 근거 (scripts/validate-daily-stop.ts, 반도체 5종목 균등비중 1,229거래일):
//   · -3% 도달 시 그날 신규 진입 중단 + 다음 거래일 하루 관망
//     → 누적수익 632% → 622% (거의 그대로), 최대낙폭 -52.0% → -42.8%, 샤프 1.16 → 1.25
//   · 기간을 4등분해도 4개 중 3개 구간에서 낙폭이 줄었고,
//     가장 크게 무너진 두 구간에서 개선폭이 가장 컸다 (+10.5%p, +13.9%p)
//   · -4%·-5%·-7%는 오히려 나빴다 → 한도를 느슨하게 잡으면 아무것도 막지 못한다
//
// 정직한 한계: 이 규칙은 "이미 발생한 오늘의 손실"을 막지 못한다(손실이 난 뒤 발동한다).
// 막는 것은 그 뒤에 이어지는 추격 매매·물타기다. 실제로 큰 손실 다음날의 방향은
// 예측되지 않았다(-3% 이하 86회에서 다음날 승률 50%, 최악 -11.9%).
import type { Portfolio, Quote, StockTicker } from "./types";
import { STOCKS } from "./types";

/** 하루 손실이 이 수준에 닿으면 신규 진입을 멈춘다 (실측으로 고른 값 — 위 주석 참조) */
export const DAILY_STOP_PCT = -3;
/** 절반쯤 왔을 때 미리 알려 준다 — 닿고 나서 알면 늦다 */
export const DAILY_WARN_PCT = -1.5;

export interface DailyRisk {
  available: boolean;
  /** 오늘 보유 종목에서 발생한 평가손익 (원) */
  todayPnlWon: number;
  /** 총자산 대비 % */
  todayPnlPct: number;
  /** 한도에 닿아 신규 진입을 멈춰야 하는 상태 */
  stopTriggered: boolean;
  /** 한도의 절반을 넘어 주의가 필요한 상태 */
  warnTriggered: boolean;
  /** 남은 여유 (원). 음수면 이미 초과 */
  remainingWon: number;
  /** 가장 크게 빠진 종목 (원인 파악용) */
  worst: { ticker: StockTicker; name: string; pnlWon: number; changePct: number } | null;
  headline: string;
  detail: string;
}

const EMPTY: DailyRisk = {
  available: false,
  todayPnlWon: 0,
  todayPnlPct: 0,
  stopTriggered: false,
  warnTriggered: false,
  remainingWon: 0,
  worst: null,
  headline: "",
  detail: "",
};

/**
 * 오늘 하루 계좌가 얼마나 빠졌는지 계산한다.
 *
 * 평단 대비 누적 손익이 아니라 **오늘 하루치**만 본다 — 데일리 스톱은 "오늘 무슨 일이
 * 벌어지고 있나"에 대한 규칙이지, 오래 들고 있어 물린 포지션을 다시 벌하는 규칙이 아니다.
 */
export function computeDailyRisk(portfolio: Portfolio, quotes: Record<string, Quote | null>, totalAssetKRW: number): DailyRisk {
  if (!(totalAssetKRW > 0) || portfolio.holdings.length === 0) return EMPTY;

  let pnl = 0;
  let counted = 0;
  let worst: DailyRisk["worst"] = null;
  for (const h of portfolio.holdings) {
    const q = quotes[h.ticker];
    if (!q || !Number.isFinite(q.change) || h.qty <= 0) continue;
    // change는 전일 종가 대비 등락액이므로, 그대로 곱하면 오늘 하루 평가손익이 된다
    const w = q.change * h.qty;
    pnl += w;
    counted++;
    if (!worst || w < worst.pnlWon) {
      worst = { ticker: h.ticker, name: STOCKS[h.ticker].name, pnlWon: Math.round(w), changePct: q.changePct };
    }
  }
  if (counted === 0) return EMPTY;

  const pct = (pnl / totalAssetKRW) * 100;
  const stopTriggered = pct <= DAILY_STOP_PCT;
  const warnTriggered = !stopTriggered && pct <= DAILY_WARN_PCT;
  const limitWon = (Math.abs(DAILY_STOP_PCT) / 100) * totalAssetKRW;
  const remainingWon = Math.round(limitWon + pnl); // pnl이 음수이므로 더하면 남은 여유

  const won = (v: number) => `${v < 0 ? "-" : ""}${Math.abs(Math.round(v)).toLocaleString("ko-KR")}원`;
  let headline: string;
  let detail: string;
  if (stopTriggered) {
    headline = `오늘은 여기서 멈추세요 — 하루 손실 한도(${DAILY_STOP_PCT}%)에 닿았습니다`;
    detail =
      `오늘 하루에만 ${won(pnl)}(${pct.toFixed(1)}%) 빠졌습니다. ` +
      `지금부터는 새로 사지 마세요. 보유분은 각자 정해둔 손절선이 처리합니다.` +
      (worst && worst.pnlWon < 0 ? ` 가장 크게 빠진 종목은 ${worst.name}(${worst.changePct.toFixed(1)}%)입니다.` : "") +
      ` 크게 빠진 날 "다음날 반등한다"는 통계적 근거는 없었습니다 — 5년 실측에서 -3% 이하로 마감한 86일의 다음날 승률은 50%였고 최악은 -11.9%였습니다.`;
  } else if (warnTriggered) {
    headline = `오늘 손실이 커지고 있습니다 (${pct.toFixed(1)}%)`;
    detail =
      `오늘 하루 ${won(pnl)} 빠졌습니다. ${won(remainingWon)} 더 빠지면 하루 한도(${DAILY_STOP_PCT}%)에 닿습니다. ` +
      `지금부터 신규 매수는 평소보다 작게 잡고, 손절선을 먼저 확인하세요.`;
  } else {
    headline = `오늘 손익 ${pnl >= 0 ? "+" : ""}${won(pnl)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
    detail = `하루 손실 한도(${DAILY_STOP_PCT}% = ${won(limitWon)})까지 ${won(remainingWon)} 여유가 있습니다.`;
  }

  return {
    available: true,
    todayPnlWon: Math.round(pnl),
    todayPnlPct: Number(pct.toFixed(2)),
    stopTriggered,
    warnTriggered,
    remainingWon,
    worst,
    headline,
    detail,
  };
}
