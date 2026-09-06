// 비서 브리핑 — 화면 맨 위에서 "사람 말"로 지금 상황을 요약한다.
//
// 왜 만들었나: 지금까지 이 앱은 카드를 나열하는 대시보드였다. 사용자는 카드 8개를 훑어 스스로 결론을
// 내야 했다. "내 주식 비서"라면 먼저 말을 걸어야 한다 — "지금 장전이고, 간밤에 미 반도체가 빠졌고,
// 정리할 종목이 하나 있어요"처럼. 이 파일은 엔진·시세·뉴스·자산을 받아 그 문장들을 만든다.
//
// 원칙:
//  1. 새로운 판단을 만들지 않는다. 결론(행 목록)은 lib/actions.ts buildDoitRows 그대로, 방향 예측은 없다.
//  2. 숫자를 지어내지 않는다 — 데이터가 없으면 그 문장을 빼거나 "아직 모름"이라고 말한다.
//  3. 순수 함수. scripts/validate-briefing.ts 로 문장 규칙을 회귀 검사한다.
import type { DoitRow } from "./actions";
import { isHeld } from "./actions";
import type { EngineSignal, MarketPhaseInfo, NewsItem, Portfolio, Quote } from "./types";
import { STOCKS } from "./types";
import { computeTopicBoard } from "./issueMap";
import { DAILY_STOP_PCT, DAILY_WARN_PCT } from "./dailyRisk";

export type AlertLevel = "danger" | "warn" | "info";
export interface BriefingAlert {
  level: AlertLevel;
  icon: string;
  text: string;
  sub?: string;
  ticker?: string; // 종목 카드로 이동할 때 쓴다
}

export interface Briefing {
  greeting: string; // "좋은 아침이에요"
  when: string; // "장전 08:32 · 개장까지 28분"
  headline: string; // 한 문장 결론
  lines: string[]; // 시장·계좌·이벤트 문장 (없으면 빈 배열)
  alerts: BriefingAlert[];
  mood: "calm" | "alert" | "danger";
  todo: { sell: number; buy: number; limit: number; hold: number };
  hasResult: boolean;
}

export interface BriefingInput {
  now: Date;
  phase: MarketPhaseInfo | null;
  rows: DoitRow[];
  result: {
    generatedAt: string;
    signals: EngineSignal[];
    news: NewsItem[];
    // 서버 응답은 available이 true일 때만 실린다(null이면 없음) — 필드 자체는 선택으로 받는다
    dailyRisk?: { available?: boolean; todayPnlWon: number; todayPnlPct: number; stopTriggered: boolean; warnTriggered: boolean } | null;
    advice?: { overall: { headline: string; riskLevel: string } } | null;
    todayPlan?: { regime: string; regimeNote: string } | null;
  } | null;
  quotes: Record<string, Quote | null> | null | undefined;
  macro: Record<string, Quote | null> | null | undefined;
  portfolio: Portfolio;
  totalAssetKrw: number;
}

const kstHour = (d: Date) => new Date(d.getTime() + 9 * 3600_000).getUTCHours();
const kstMinutes = (d: Date) => {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return k.getUTCHours() * 60 + k.getUTCMinutes();
};
const pct = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
const manwon = (v: number) => {
  const neg = v < 0;
  const man = Math.round(Math.abs(v) / 10_000);
  const body = man >= 10_000 ? `${Math.floor(man / 10_000)}억 ${(man % 10_000).toLocaleString("ko-KR")}만원` : `${man.toLocaleString("ko-KR")}만원`;
  return (neg ? "-" : "") + body;
};

function greetingFor(now: Date): string {
  const h = kstHour(now);
  if (h >= 5 && h < 11) return "좋은 아침이에요";
  if (h >= 11 && h < 14) return "점심시간이에요";
  if (h >= 14 && h < 18) return "오후예요";
  if (h >= 18 && h < 23) return "오늘도 수고하셨어요";
  return "늦은 시간이에요";
}

function whenFor(now: Date, phase: MarketPhaseInfo | null): string {
  const m = kstMinutes(now);
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  if (!phase) return hhmm;
  const open = 9 * 60;
  const close = 15 * 60 + 30;
  if (phase.phase === "장전") return `장전 ${hhmm} · 개장까지 ${open - m}분`;
  if (phase.phase === "마감임박" || phase.phase === "동시호가") return `${phase.phase} ${hhmm} · 마감까지 ${Math.max(0, close - m)}분`;
  if (phase.phase === "장초반" || phase.phase === "장중" || phase.phase === "점심시간대") return `${phase.phase} ${hhmm} · 마감까지 ${Math.max(0, close - m)}분`;
  if (phase.phase === "장마감") return `장 마감 ${hhmm} · 다음 개장일 준비`;
  return `${phase.phase} ${hhmm}`;
}

export function buildBriefing(input: BriefingInput): Briefing {
  const { now, phase, rows, result, quotes, macro, portfolio } = input;
  const alerts: BriefingAlert[] = [];
  const lines: string[] = [];
  const todo = {
    sell: rows.filter((r) => r.kind === "sell").length,
    buy: rows.filter((r) => r.kind === "buy").length,
    limit: rows.filter((r) => r.kind === "limit").length,
    hold: rows.filter((r) => r.kind === "hold").length,
  };
  const held = portfolio.holdings.filter((h) => isHeld(h));

  // ── 시장 한 줄 ──────────────────────────────────────────────────────────────
  const marketBits: string[] = [];
  const kospi = macro?.kospi;
  const sox = macro?.sox;
  const vix = macro?.vix;
  if (kospi && Number.isFinite(kospi.changePct)) marketBits.push(`코스피 ${pct(kospi.changePct)}`);
  if (sox && Number.isFinite(sox.changePct)) marketBits.push(`${phase?.phase === "장전" || phase?.phase === "장초반" ? "간밤 " : ""}미 반도체지수 ${pct(sox.changePct)}`);
  if (vix && vix.price >= 25) marketBits.push(`VIX ${vix.price.toFixed(0)}(불안)`);
  if (marketBits.length) lines.push(`${marketBits.join(", ")}.`);

  // ── 뉴스 축 한 줄 (코스피 기준 방향) ─────────────────────────────────────
  if (result?.news?.length) {
    const board = computeTopicBoard(result.news);
    const neg = board.topics.filter((t) => t.pressure <= -1).slice(0, 2).map((t) => t.label);
    const pos = board.topics.filter((t) => t.pressure >= 1).slice(0, 2).map((t) => t.label);
    if (neg.length || pos.length) {
      lines.push(
        `뉴스는 ${neg.length ? `${neg.join("·")} 쪽에 악재` : ""}${neg.length && pos.length ? ", " : ""}${pos.length ? `${pos.join("·")} 쪽에 호재` : ""}가 몰려 있어요.`,
      );
    }
    for (const u of board.upcoming.filter((x) => x.impact === "높음").slice(0, 2)) {
      alerts.push({ level: "warn", icon: "⏰", text: `${u.title.slice(0, 40)} (${u.when})`, sub: "발표 전엔 새 매수를 평소의 70%로 — 엔진이 자동으로 줄입니다" });
    }
  }

  // ── 계좌 한 줄 + 위험 알림 ───────────────────────────────────────────────
  if (held.length && input.totalAssetKrw > 0) {
    let pnl = 0;
    let counted = 0;
    for (const h of held) {
      const q = quotes?.[h.ticker];
      if (!q || !Number.isFinite(q.change)) continue;
      pnl += q.change * h.qty;
      counted++;
    }
    const p = input.totalAssetKrw > 0 ? (pnl / input.totalAssetKrw) * 100 : 0;
    if (counted > 0) lines.push(`내 자산 ${manwon(input.totalAssetKrw)}, 오늘 ${pnl >= 0 ? "+" : ""}${manwon(pnl)}(${pct(p)}).`);
    const dr = result?.dailyRisk && result.dailyRisk.available !== false ? result.dailyRisk : null;
    if (dr && dr.stopTriggered) {
      alerts.push({ level: "danger", icon: "🛑", text: `오늘 하루 손실 한도(${DAILY_STOP_PCT}%)에 닿았어요 — 새로 사지 마세요`, sub: `오늘 ${manwon(dr.todayPnlWon)}(${pct(dr.todayPnlPct)}). 보유분은 손절선만 지키세요` });
    } else if (dr && dr.warnTriggered) {
      alerts.push({ level: "warn", icon: "⚠️", text: `오늘 손실이 커지고 있어요 (${pct(dr.todayPnlPct)})`, sub: `${DAILY_WARN_PCT}% 경고선을 넘었어요. 새 매수는 작게, 손절선부터 확인` });
    } else if (counted > 0 && p <= DAILY_WARN_PCT) {
      alerts.push({ level: "warn", icon: "⚠️", text: `오늘 손실이 커지고 있어요 (${pct(p)})`, sub: "새 매수는 작게, 손절선부터 확인" });
    }
  }

  // ── 보유 종목별 손절선·익절선 근접 ────────────────────────────────────────
  if (result) {
    for (const h of held) {
      const sig = result.signals.find((s) => s.ticker === h.ticker);
      if (!sig) continue;
      const price = quotes?.[h.ticker]?.price ?? sig.price;
      const cur = STOCKS[h.ticker].currency;
      const fmt = (v: number) => (cur === "USD" ? `$${v.toFixed(2)}` : `${Math.round(v).toLocaleString("ko-KR")}원`);
      if (sig.stopPrice != null && price > 0) {
        const dist = ((price - sig.stopPrice) / price) * 100;
        if (dist <= 0) alerts.push({ level: "danger", icon: "🔻", text: `${sig.name} 손절선(${fmt(sig.stopPrice)}) 아래예요 — 원칙대로 정리`, ticker: h.ticker });
        else if (dist <= 1.5) alerts.push({ level: "warn", icon: "🔻", text: `${sig.name} 손절선까지 ${dist.toFixed(1)}% (${fmt(sig.stopPrice)})`, sub: "여기서 흔들리면 계획대로 파세요", ticker: h.ticker });
      }
      const exit1 = sig.scaledExit[0];
      if (exit1 && price >= exit1.price && sig.action !== "부분매도" && sig.action !== "전량매도") {
        alerts.push({ level: "info", icon: "🎯", text: `${sig.name} 1차 익절선(${fmt(exit1.price)}) 위예요`, sub: "장중 흐름이 꺾이면 절반은 챙기세요", ticker: h.ticker });
      }
    }
    // 속보 — 보유·매수 신호 종목에 닿는 것만
    const watch = new Set([...held.map((h) => h.ticker), ...rows.filter((r) => r.kind === "buy" || r.kind === "limit").map((r) => r.ticker)]);
    for (const sig of result.signals) {
      if (!watch.has(sig.ticker)) continue;
      const hit = (sig.issueImpacts ?? []).find((i) => i.isBreaking && i.strength >= 2);
      if (hit) alerts.push({ level: hit.direction === "악재" ? "warn" : "info", icon: "📰", text: `${sig.name} ${hit.direction} 속보: ${hit.title.slice(0, 36)}`, sub: hit.why, ticker: sig.ticker });
      if (sig.riskOverlay?.shockRisk && !alerts.some((a) => a.icon === "🔴")) {
        alerts.push({ level: "warn", icon: "🔴", text: "3시간 안에 고영향 악재 속보(전쟁·관세·미국정책·중국)", sub: "새 매수는 70% 규모, VWAP 위 안착 확인 후" });
      }
    }
    // 분석이 오래됐으면 — 장중에만 의미 있다
    const ageMin = (now.getTime() - new Date(result.generatedAt).getTime()) / 60_000;
    const inSession = phase && ["장초반", "장중", "점심시간대", "마감임박", "동시호가"].includes(phase.phase);
    if (inSession && ageMin > 30) alerts.push({ level: "warn", icon: "🕒", text: `분석이 ${Math.round(ageMin)}분 지났어요`, sub: "장중엔 30분마다 다시 분석하는 게 좋아요" });
  }

  // ── 장 시간대 안내 ────────────────────────────────────────────────────────
  if (phase?.phase === "마감임박" && held.length) alerts.push({ level: "info", icon: "⏳", text: "마감 50분 전 — 오늘 청산할지 넘길지 정할 시간", sub: "수익 중이면 절반 청산, 넘길 거면 손절 예약" });
  if (phase?.phase === "장전") alerts.push({ level: "info", icon: "🌅", text: "개장 전 — 간밤 미국 지표와 예정 이벤트를 먼저 확인", sub: "첫 30분은 방향이 자주 뒤집혀요. VWAP 위 안착 후 진입" });

  // ── 한 문장 결론 ──────────────────────────────────────────────────────────
  let headline: string;
  if (!result) {
    headline = held.length ? "분석을 받으면 보유 종목별로 지금 할 일을 알려드릴게요" : "자산을 입력하고 분석을 받으면 맞춤 브리핑이 시작돼요";
  } else {
    const parts: string[] = [];
    if (todo.sell) parts.push(`정리할 종목 ${todo.sell}개`);
    if (todo.buy) parts.push(`살 자리 ${todo.buy}개`);
    if (todo.limit) parts.push(`지정가 걸 종목 ${todo.limit}개`);
    if (parts.length) headline = `지금 할 일 — ${parts.join(", ")}`;
    else if (todo.hold) headline = `오늘은 건드릴 게 없어요 — 보유 ${todo.hold}종목은 손절선만 지키면 됩니다`;
    else headline = "오늘은 살 자리도 팔 자리도 없어요 — 쉬는 것도 전략이에요";
    if (result.advice?.overall.headline && parts.length === 0) lines.push(`AI 총평: ${result.advice.overall.headline}`);
  }

  // 순서: 위험 → 주의 → 정보. 같은 급에서는 먼저 만든 순서.
  const order: Record<AlertLevel, number> = { danger: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);
  const mood: Briefing["mood"] = alerts.some((a) => a.level === "danger") ? "danger" : alerts.some((a) => a.level === "warn") ? "alert" : "calm";

  return { greeting: greetingFor(now), when: whenFor(now, phase), headline, lines, alerts: alerts.slice(0, 6), mood, todo, hasResult: Boolean(result) };
}
