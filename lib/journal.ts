// 매매일지 — 이 앱의 추천이 실제로 맞았는지 기록하고 채점한다.
//
// 왜 만들었나: 이 앱은 지금까지 조언만 하고, 그 조언이 맞았는지 한 번도 확인하지 않았다.
// 사용자의 목표가 "수익"이라면 이건 근본적인 공백이다. 피드백이 없으면
//   · 사용자는 앱을 믿어야 할지 판단할 방법이 없고,
//   · "왜 손해를 봤는가"(추천이 틀렸나 / 내가 안 지켰나)를 구분할 수 없다.
//
// 설계 원칙
//  1. 브라우저에만 저장한다. 매매 내역은 민감 정보이고, 서버에 보관할 이유가 없다.
//  2. 채점은 "앱이 말한 대로 했다면"을 기준으로 한다 — 사용자가 실제로 무엇을 했는지는 모른다.
//     그래서 이건 "내 수익률"이 아니라 "이 앱 추천의 성적표"다. 이 구분을 화면에도 명시한다.
//  3. 손절가·목표가가 함께 기록된 추천만 채점한다. 기준이 없으면 사후 해석이 되어버린다.
//
// 정직한 한계: 장중 고가·저가를 모르므로 "손절선을 스쳤는지"는 알 수 없고, 확인 시점의
// 종가(또는 현재가)만으로 채점한다. 따라서 실제 매매보다 결과가 좋게 나오는 쪽으로 치우친다.
// 이 편향을 화면에 그대로 적어둔다.
import type { StockTicker } from "./types";

export const JOURNAL_KEY = "trade-journal-v1";
/** 이 기간이 지나면 판정을 확정한다 (단타 앱이므로 짧게) */
const SETTLE_DAYS = 5;
const MAX_ENTRIES = 200;

export interface JournalEntry {
  id: string; // `${ticker}-${추천시각}`
  ticker: StockTicker;
  name: string;
  recommendedAt: string; // ISO
  action: string; // 신규매수 / 추가매수 / 부분매도 / 전량매도 / 손절 / 보유 / 관망
  priceAtRec: number; // 추천 시점 현재가
  entryPrice: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  /** 채점 결과 — 아직 안 끝났으면 null */
  outcome: null | {
    checkedAt: string;
    priceAtCheck: number;
    /** 목표 도달 / 손절 도달 / 아직 진행 중 / 기간 만료 */
    verdict: "목표달성" | "손절" | "진행중" | "기간만료";
    /** 추천 시점 대비 등락 (%) — 매도 추천이면 부호를 뒤집어 "추천이 옳았나"로 읽는다 */
    signedPct: number;
  };
}

export interface JournalSummary {
  available: boolean;
  settled: number; // 판정이 끝난 건수
  hit: number; // 추천 방향이 맞은 건수
  hitRatePct: number;
  avgSignedPct: number;
  /** 방향이 맞은 것과 틀린 것의 평균 크기 — 손익비 */
  avgWinPct: number;
  avgLossPct: number;
  pending: number;
  headline: string;
  caution: string;
}

/** 매수 계열이면 오르는 게 정답, 매도 계열이면 내리는 게 정답 */
function directionOf(action: string): 1 | -1 | 0 {
  if (action === "신규매수" || action === "추가매수") return 1;
  if (action === "부분매도" || action === "전량매도" || action === "손절") return -1;
  return 0; // 보유·관망은 방향 주장이 아니므로 채점하지 않는다
}

/** 채점 대상인가 — 방향을 주장했고 기준가가 있는 추천만 */
export function isScorable(action: string, priceAtRec: number | null | undefined): boolean {
  return directionOf(action) !== 0 && Boolean(priceAtRec) && Number.isFinite(priceAtRec as number) && (priceAtRec as number) > 0;
}

export function loadJournal(): JournalEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as JournalEntry[]).filter((e) => e && e.id && e.ticker) : [];
  } catch {
    return [];
  }
}

export function saveJournal(entries: JournalEntry[]): void {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // 저장 실패는 조용히 넘긴다 — 일지는 부가 기능이라 여기서 앱을 막으면 안 된다
  }
}

/**
 * 새 추천을 일지에 담고, 이전 추천들을 현재가로 채점한다.
 *
 * 같은 종목을 하루에 여러 번 분석해도 기록이 폭증하지 않도록,
 * "같은 종목 + 같은 날 + 같은 방향"이면 첫 기록만 남긴다.
 */
export function recordAndScore(
  prev: JournalEntry[],
  fresh: { ticker: StockTicker; name: string; action: string; price: number; entryPrice: number | null; targetPrice: number | null; stopPrice: number | null }[],
  currentPrices: Record<string, number | null | undefined>,
  now = new Date(),
): JournalEntry[] {
  // 1) 기존 기록 채점
  const scored = prev.map((e) => {
    if (e.outcome && e.outcome.verdict !== "진행중") return e;
    const cur = currentPrices[e.ticker];
    if (!cur || !Number.isFinite(cur) || cur <= 0) return e;
    const dir = directionOf(e.action);
    if (dir === 0) return e;

    const rawPct = ((cur - e.priceAtRec) / e.priceAtRec) * 100;
    const signedPct = Number((rawPct * dir).toFixed(2)); // 매도 추천이면 내려야 +
    const ageDays = (now.getTime() - new Date(e.recommendedAt).getTime()) / 86_400_000;

    let verdict: NonNullable<JournalEntry["outcome"]>["verdict"] = "진행중";
    if (dir === 1 && e.targetPrice && cur >= e.targetPrice) verdict = "목표달성";
    else if (dir === 1 && e.stopPrice && cur <= e.stopPrice) verdict = "손절";
    else if (dir === -1 && e.stopPrice && cur <= e.stopPrice) verdict = "목표달성"; // 팔라고 했고 실제로 내려갔다
    else if (ageDays >= SETTLE_DAYS) verdict = "기간만료";

    return { ...e, outcome: { checkedAt: now.toISOString(), priceAtCheck: cur, verdict, signedPct } };
  });

  // 2) 새 추천 추가 (중복 제거)
  const day = now.toISOString().slice(0, 10);
  const seen = new Set(scored.filter((e) => e.recommendedAt.slice(0, 10) === day).map((e) => `${e.ticker}|${e.action}`));
  const added: JournalEntry[] = [];
  for (const f of fresh) {
    if (!isScorable(f.action, f.price)) continue;
    const key = `${f.ticker}|${f.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({
      id: `${f.ticker}-${now.getTime()}`,
      ticker: f.ticker,
      name: f.name,
      recommendedAt: now.toISOString(),
      action: f.action,
      priceAtRec: f.price,
      entryPrice: f.entryPrice,
      targetPrice: f.targetPrice,
      stopPrice: f.stopPrice,
      outcome: null,
    });
  }
  return [...scored, ...added].slice(-MAX_ENTRIES);
}

export function summarize(entries: JournalEntry[]): JournalSummary {
  const done = entries.filter((e) => e.outcome && e.outcome.verdict !== "진행중");
  const pending = entries.filter((e) => !e.outcome || e.outcome.verdict === "진행중").length;
  if (done.length === 0) {
    return {
      available: false, settled: 0, hit: 0, hitRatePct: 0, avgSignedPct: 0, avgWinPct: 0, avgLossPct: 0, pending,
      headline: pending > 0 ? `추천 ${pending}건을 지켜보는 중입니다` : "아직 채점할 추천이 없습니다",
      caution: "",
    };
  }
  const pcts = done.map((e) => e.outcome!.signedPct);
  const wins = pcts.filter((p) => p > 0);
  const losses = pcts.filter((p) => p <= 0);
  const hitRate = (wins.length / done.length) * 100;
  const avg = pcts.reduce((a, b) => a + b, 0) / done.length;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;

  // 표본이 적으면 숫자를 단정적으로 읽지 않도록 한다.
  // 이항분포 기준 30건 미만에서는 적중률 오차가 ±9%p를 넘는다.
  const thin = done.length < 30;
  const headline =
    `추천 ${done.length}건 중 방향이 맞은 것 ${wins.length}건 (${hitRate.toFixed(0)}%) · ` +
    `평균 ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%`;
  const caution =
    (thin ? `표본이 ${done.length}건뿐이라 이 숫자는 아직 실력과 운을 구분하지 못합니다(30건은 넘어야 합니다). ` : "") +
    "그리고 이건 '내 수익률'이 아니라 '앱 추천의 성적표'입니다 — 실제로 그대로 매매했는지는 앱이 알 수 없고, " +
    "장중 고저가를 모르므로 손절선을 스쳤다 되돌아온 경우는 반영되지 않아 실제보다 좋게 나옵니다.";

  return {
    available: true, settled: done.length, hit: wins.length,
    hitRatePct: Number(hitRate.toFixed(1)), avgSignedPct: Number(avg.toFixed(2)),
    avgWinPct: Number(avgWin.toFixed(2)), avgLossPct: Number(avgLoss.toFixed(2)),
    pending, headline, caution,
  };
}
