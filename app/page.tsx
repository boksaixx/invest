"use client";

// 토스 스타일 대시보드: 현금/보유 입력 → 실시간 시세 → AI 매매 조언
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { AiAdvice, EngineSignal, MasterScore, NewsItem, Portfolio, Quote } from "@/lib/types";
import { STOCKS, TICKER_LIST } from "@/lib/types";
import ForecastChart from "./ForecastChart";
// 뉴스 집계 — Claude에게 보내는 것과 "똑같은" 계산을 화면에도 쓴다.
// 사람이 보는 요약과 AI가 받는 요약이 다르면, 왜 그런 판단이 나왔는지 검증할 방법이 없어진다.
import { computeNewsSignal } from "@/lib/newsSignal";
// 매매일지 — 이 앱의 추천이 실제로 맞았는지 기록하고 채점한다(브라우저에만 저장).
import { loadJournal, recordAndScore, saveJournal, summarize, type JournalEntry } from "@/lib/journal";
// 문서 탭이 인용하는 검증 수치는 반드시 실측 파일에서 읽는다.
// 코드에 숫자를 박아두면 데이터가 갱신될 때 앱이 조용히 낡은 값을 말하게 된다(과거에 실제로 겪음).
import analogStats from "@/data/analog-stats.json";
import touchStats from "@/data/touch-stats.json";
import probStats from "@/data/probability-stats.json";
import powerStats from "@/data/power-stats.json";

const TICKERS = TICKER_LIST.map((ticker) => ({ ticker, name: STOCKS[ticker].name }));

interface MarketData {
  quotes: Record<string, Quote | null>;
  macro: Record<string, Quote | null>;
  fetchedAt: string;
}

interface AdviceResponse {
  signals: EngineSignal[];
  advice: AiAdvice | null;
  adviceError?: string | null;
  masterScore?: MasterScore | null;
  news: NewsItem[];
  newsError?: string | null;
  aiAvailable: boolean;
  newsLive: boolean;
  marketPhase?: { phase: string; kstTime: string; note: string };
  marketPhaseUS?: { phase: string; kstTime: string; note: string };
  relativeStrengthSummary?: string | null;
  sectorConcentrationWarning?: string | null;
  correlationCap?: { warnings: string[]; pairs: { a: string; b: string; corr: number; combinedWeightPct: number }[] } | null;
  todayPlan?: {
    regime: "폭락장" | "급등과열" | "변동성확대" | "보통";
    regimeNote: string;
    trades: {
      kind: "눌림목매수" | "폭락반등매수" | "급등익절";
      ticker: string;
      name: string;
      currency: "KRW" | "USD";
      currentPrice: number;
      entryPrice: number | null;
      targetPrice: number | null;
      stopPrice: number | null;
      sellLimitPrice: number | null;
      sigmaDailyPct: number;
      suggestedQty: number | null;
      suggestedBudget: number | null;
      headline: string;
      rationale: string;
      cautions: string[];
    }[];
    holderGuide: string[];
    marketNote: string;
    skippedNote: string | null;
    holdEdge: {
      available: boolean;
      overnightPct: number;
      intradayPct: number;
      totalPct: number;
      verdict: "보유우위" | "장중우위" | "혼재";
      note: string;
    } | null;
    scenarios: { name: string; label: string; note: string; lowConfidence: boolean }[];
  } | null;
  creditBalance?: { latestTrillionKrw: number; change20dPct: number; note: string } | null;
  portfolioRisk?: {
    totalValue: number;
    sigmaDailyPct: number;
    sigmaDailyAmount: number;
    loss5Pct: number;
    loss1Pct: number;
    gain5Pct: number;
    effectiveBets: number;
    naiveUnderestimatePct: number;
    topWeight: { name: string; weightPct: number } | null;
    warnings: string[];
  } | null;
  dailyRisk?: {
    todayPnlWon: number;
    todayPnlPct: number;
    stopTriggered: boolean;
    warnTriggered: boolean;
    remainingWon: number;
    worst: { name: string; pnlWon: number; changePct: number } | null;
    headline: string;
    detail: string;
  } | null;
  generatedAt: string;
  error?: string;
}

const DEFAULT_PORTFOLIO: Portfolio = { cash: 20_000_000, cashUSD: 0, holdings: [] };
const PORTFOLIO_COOKIE = "portfolio-v1-backup";

function readPortfolioCookie(): Portfolio | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${PORTFOLIO_COOKIE}=([^;]*)`));
    if (!match) return null;
    return JSON.parse(decodeURIComponent(match[1])) as Portfolio;
  } catch {
    return null;
  }
}

// localStorage만 쓰면 iOS "홈 화면에 추가" PWA 등 일부 환경에서 저장소가 예고 없이
// 초기화되는 경우가 있어(iOS의 스토리지 정리 정책), 1년짜리 쿠키를 이중 백업으로 둔다.
// localStorage가 비어있으면 쿠키에서 복구하고, 복구한 값을 다시 localStorage에도 채워둔다.
// cashUSD는 과거 미국 종목을 다루던 버전의 잔재다. 지금은 전 종목이 원화라 항상 0이지만,
// 저장된 데이터 호환을 위해 필드는 남겨두고 기본값 0으로 보정한다.
function normalizePortfolio(p: Partial<Portfolio> | null | undefined): Portfolio {
  if (!p) return DEFAULT_PORTFOLIO;
  return { cash: p.cash ?? 0, cashUSD: p.cashUSD ?? 0, holdings: p.holdings ?? [] };
}

function loadPortfolio(): Portfolio {
  if (typeof window === "undefined") return DEFAULT_PORTFOLIO;
  try {
    const raw = localStorage.getItem("portfolio-v1");
    if (raw) return normalizePortfolio(JSON.parse(raw) as Portfolio);
  } catch {}
  const fromCookie = readPortfolioCookie();
  if (fromCookie) {
    const normalized = normalizePortfolio(fromCookie);
    try {
      localStorage.setItem("portfolio-v1", JSON.stringify(normalized));
    } catch {}
    return normalized;
  }
  return DEFAULT_PORTFOLIO;
}

function persistPortfolio(p: Portfolio): void {
  try {
    localStorage.setItem("portfolio-v1", JSON.stringify(p));
  } catch {}
  try {
    document.cookie = `${PORTFOLIO_COOKIE}=${encodeURIComponent(JSON.stringify(p))}; max-age=31536000; path=/; SameSite=Lax`;
  } catch {}
}

// "AI 정밀 분석" 결과는 Claude 호출 비용이 드는 데이터라, 화면(탭)이 백그라운드에서
// 메모리 정리로 날아가거나(폰 화면을 껐다 켤 때 흔함) 앱을 재실행해도 남아있도록 로컬에 저장해둔다.
// 오래 지나면 시세가 낡아 위험하므로 6시간 넘은 캐시는 복원하지 않고 버린다.
const RESULT_CACHE_KEY = "advice-result-v1";
const RESULT_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function loadCachedResult(): AdviceResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(RESULT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdviceResponse;
    if (!parsed?.generatedAt) return null;
    if (Date.now() - new Date(parsed.generatedAt).getTime() > RESULT_CACHE_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistResult(r: AdviceResponse): void {
  try {
    localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify(r));
  } catch {}
}

// localStorage가 실제로 쓰기/읽기가 되는지 직접 검증한다. 시크릿(프라이빗) 모드,
// 브라우저의 "사이트 데이터 저장 차단" 설정, 저장공간 부족 등으로 저장이 조용히
// 실패하는 경우가 있는데, try/catch로 감싸두면 그런 실패가 사용자에게 전혀 보이지
// 않고 "왜 자꾸 초기화되지"라는 혼란만 남긴다 — 그래서 이 자가진단 결과를 화면에
// 명확히 보여준다(아래 storageBlocked 배너).
function testStorageWritable(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const testKey = "__storage_test__";
    localStorage.setItem(testKey, "1");
    const ok = localStorage.getItem(testKey) === "1";
    localStorage.removeItem(testKey);
    return ok;
  } catch {
    return false;
  }
}

function won(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "-";
  return Math.round(n).toLocaleString("ko-KR");
}

// 큰 금액은 "만원" 단위가 훨씬 읽기 쉽다 (예: 2,134,000원 → 213만원, 1억 넘으면 "1억 2,340만원").
function manwon(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "-";
  const neg = n < 0;
  const abs = Math.abs(n);
  const man = Math.round(abs / 10_000);
  const body =
    man >= 10_000
      ? `${Math.floor(man / 10_000)}억 ${(man % 10_000).toLocaleString("ko-KR")}만원`
      : `${man.toLocaleString("ko-KR")}만원`;
  return (neg ? "-" : "") + body;
}

// 통화 단위(원/달러)를 반영한 가격 표기 — 국내 종목은 "12,345원", 미국 종목은 "$123.45"로 표시한다.
// 가격 표시의 마지막 방어선.
// 앞단(시세 파싱·엔진)에서 이미 걸러내지만, 이 앱의 숫자는 사용자가 그대로 증권사에 입력하는
// 값이라 "이상한 숫자를 예쁘게 렌더링하는" 경로를 아예 남기지 않는다.
// 음수 주가·Infinity는 존재할 수 없는 값이므로 "-"로 표시한다 (예전에는 "-35,062원", "∞원"으로 그대로 나왔다).
function fmt(n: number | null | undefined, currency: "KRW" | "USD"): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "-";
  if (currency === "USD") return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${Math.round(n).toLocaleString("ko-KR")}원`;
}

function pctClass(v: number | null | undefined): string {
  if (v == null || v === 0) return "flat";
  return v > 0 ? "up" : "down";
}

function badgeClass(action: string): string {
  if (action === "신규매수" || action === "추가매수") return "badge badge-buy";
  if (action === "부분매도" || action === "전량매도") return "badge badge-sell";
  if (action === "손절") return "badge badge-danger";
  return "badge badge-hold";
}

function staleness(iso: string | undefined, label: string = "시세"): string | null {
  if (!iso) return null;
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return `방금 전 ${label}`;
  if (diffMin > 60) return `${Math.round(diffMin / 60)}시간 전 ${label} (지연 큼 — 주문 전 재확인 필수)`;
  if (diffMin >= 15) return `${diffMin}분 전 ${label} (지연 가능성 — 주문 전 재확인 권장)`;
  return `${diffMin}분 전 ${label}`;
}

function momentumLabel(m: string): string {
  const map: Record<string, string> = {
    강한상승: "🔥 강한 상승",
    상승: "↗ 상승",
    중립: "→ 중립",
    하락: "↘ 하락",
    강한하락: "🧊 강한 하락",
  };
  return map[m] ?? m;
}

// 미보유 시 매수 강도(0~10)의 색상 톤 — 4점 미만은 아직 근거 부족(회색)
function buyTone(score: number): "buy" | "neutral" {
  return score >= 4 ? "buy" : "neutral";
}
// 보유 중 매도 강도(0~10)의 색상 톤 — 9점 이상은 손절/즉시매도 수준(검정=위험)
function sellTone(score: number): "danger" | "sell" | "neutral" {
  if (score >= 9) return "danger";
  if (score >= 4) return "sell";
  return "neutral";
}

interface ScoreInfo {
  score: number;
  tone: "buy" | "sell" | "danger" | "neutral";
  label: string; // "매수 강도" | "매도 강도"
  oneLiner: string;
}

/**
 * 0~10 숫자만으로는 그게 높은 값인지 낮은 값인지 알 수 없다.
 * "7점"이 잘한 건지 못한 건지 판단하려면 눈금이 필요하다.
 *
 * 구간은 엔진이 실제로 행동을 바꾸는 문턱(4점, 9점)에 맞췄다 —
 * 4점 미만은 엔진이 "관망"으로 두는 구간이고, 9점 이상은 즉시 정리를 권하는 구간이다.
 * 임의로 나눈 등급이 아니라 엔진의 의사결정 경계 그대로다.
 */
const SCORE_BANDS: { max: number; name: string; buy: string; sell: string }[] = [
  { max: 1, name: "거의 없음", buy: "살 이유가 거의 없어요", sell: "팔 이유가 거의 없어요" },
  { max: 3, name: "약함", buy: "아직 근거가 부족해요", sell: "아직 서두를 때는 아니에요" },
  { max: 6, name: "보통", buy: "조건이 맞으면 검토할 만해요", sell: "슬슬 정리를 생각할 때예요" },
  { max: 8, name: "강함", buy: "지금 사도 괜찮은 자리예요", sell: "정리하는 쪽이 나아 보여요" },
  { max: 10, name: "매우 강함", buy: "지금이 가장 강한 신호예요", sell: "지금 정리하세요" },
];
/**
 * 보유 중인 종목의 판단을 세 갈래로 정리한다 — 팔기 / 지키기 / 더 사기.
 *
 * 왜 필요한가: 지금까지는 보유 종목에 "매도 강도 3/10"처럼 한 축만 보여줬다.
 * 낮은 매도 강도가 "지키라"는 뜻인지 "사도 된다"는 뜻인지 초보자는 알 수 없다.
 * 엔진의 action을 사용자가 실제로 할 수 있는 세 행동으로 번역한다.
 */
type HoldChoice = "팔기" | "지키기" | "더 사기";
function holdVerdict(action: string | undefined): { choice: HoldChoice; why: string } {
  if (action === "손절") return { choice: "팔기", why: "손절선이 깨졌어요. 원칙대로 정리할 자리입니다" };
  if (action === "전량매도") return { choice: "팔기", why: "들고 있을 이유가 사라졌어요" };
  if (action === "부분매도") return { choice: "팔기", why: "절반만 정리해 위험을 줄일 자리예요" };
  if (action === "추가매수") return { choice: "더 사기", why: "지금까지의 판단이 맞았고, 더 실을 만한 자리예요" };
  return { choice: "지키기", why: "지금 사거나 팔 이유가 둘 다 약해요. 손절선만 지키면 됩니다" };
}
const HOLD_CHOICES: HoldChoice[] = ["팔기", "지키기", "더 사기"];

function scoreBand(score: number, kind: "buy" | "sell"): { name: string; text: string; idx: number } {
  const i = SCORE_BANDS.findIndex((b) => score <= b.max);
  const b = SCORE_BANDS[i < 0 ? SCORE_BANDS.length - 1 : i];
  return { name: b.name, text: kind === "buy" ? b.buy : b.sell, idx: i < 0 ? SCORE_BANDS.length - 1 : i };
}

// 종목 하나의 최종 표시 점수를 계산 — AI 판단이 있으면 그 값을, 없으면 룰 엔진 1차 계산값을 쓴다.
// 보유 중이라도 action이 "추가매수"(수익 중 피라미딩)면 매도강도가 아니라 "추가매수 강도"를 보여줘야
// "팔아야 하나" 대신 "더 사도 되나"를 정확히 전달할 수 있다.
function computeScoreInfo(holding: boolean, sig: EngineSignal | undefined, ai: AiAdvice["stocks"][number] | undefined): ScoreInfo | null {
  if (!sig) return null;
  const action = ai?.action ?? sig.action;
  if (holding && action === "추가매수") {
    const score = ai?.actionScore ?? sig.buyStrength;
    return { score, tone: buyTone(score), label: "추가매수 강도", oneLiner: ai?.headline ?? sig.actionSummary };
  }
  if (holding) {
    const score = ai?.actionScore ?? sig.sellStrength;
    if (score == null) return null;
    return { score, tone: sellTone(score), label: "매도 강도", oneLiner: ai?.headline ?? sig.actionSummary };
  }
  const score = ai?.actionScore ?? sig.buyStrength;
  return { score, tone: buyTone(score), label: "매수 강도", oneLiner: ai?.headline ?? sig.actionSummary };
}

const FONT_SCALE_STEPS = [0.85, 1, 1.15, 1.3, 1.45];
const FONT_SCALE_LABELS = ["아주 작게", "기본", "크게", "더 크게", "아주 크게"];
const FONT_SCALE_KEY = "font-scale-v1";

function loadFontScaleIndex(): number {
  if (typeof window === "undefined") return 1;
  try {
    const raw = localStorage.getItem(FONT_SCALE_KEY);
    const idx = raw ? Number(raw) : 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < FONT_SCALE_STEPS.length) return idx;
  } catch {}
  return 1;
}

export default function Home() {
  const [portfolio, setPortfolio] = useState<Portfolio>(DEFAULT_PORTFOLIO);
  // 화면 탭 — 스크롤 지옥을 없애기 위해 3개 탭으로 분리 (오늘 할 일 / 종목 / 뉴스·시장정보)
  const [tab, setTab] = useState<"오늘" | "종목" | "정보" | "분석방식">("오늘");
  // 작전 카드에서 트레이드별 "왜 이 판단인가"(검증 통계) 펼침 상태
  const [openWhy, setOpenWhy] = useState<Record<string, boolean>>({});
  // 종목 카드 펼침 — 5개 카드를 전부 펼쳐두면 종목 탭이 1만 픽셀을 넘어 스크롤 지옥이 된다.
  // 기본은 "지금 볼 이유가 있는 것"만 펼친다: 보유 중이거나 행동을 권하는 종목.
  // 사용자가 직접 접거나 편 종목은 그 선택을 기억한다(null = 아직 안 건드림).
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({});
  const [market, setMarket] = useState<MarketData | null>(null);
  const [result, setResult] = useState<AdviceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newsNotice, setNewsNotice] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, string> | null>(null);
  const [snapshotTime, setSnapshotTime] = useState<string | null>(null);
  const [snapshotMasterScore, setSnapshotMasterScore] = useState<MasterScore | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fontScaleIdx, setFontScaleIdx] = useState(1);
  const [fontScaleLoaded, setFontScaleLoaded] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  // 기본 비밀번호로 열려 있으면(APP_PASSWORD 미설정) 배포 주소를 아는 사람은 누구나
  // 내 보유 종목·수량을 볼 수 있다. 조용히 두면 영영 모르므로 화면에 알린다.
  const [defaultPassword, setDefaultPassword] = useState(false);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [hostname, setHostname] = useState<string | null>(null);

  // 글자 크기: CSS 변수(--font-scale)를 바꾸면 전체 폰트 크기가 한 번에 조정되고, 다음에 켜도 유지되도록 저장한다.
  // fontScaleLoaded가 true가 되기 전에는 저장하지 않는다 — 그렇지 않으면 저장된 값을 불러오기도 전에
  // 기본값(1)으로 먼저 덮어써버려서 다시 켰을 때 설정이 초기화되는 문제가 생긴다.
  useEffect(() => {
    setFontScaleIdx(loadFontScaleIndex());
    setFontScaleLoaded(true);
  }, []);
  useEffect(() => {
    if (!fontScaleLoaded) return;
    document.documentElement.style.setProperty("--font-scale", String(FONT_SCALE_STEPS[fontScaleIdx]));
    try {
      localStorage.setItem(FONT_SCALE_KEY, String(fontScaleIdx));
    } catch {}
  }, [fontScaleIdx, fontScaleLoaded]);

  function toggleExpand(ticker: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }

  // 초기 로드
  useEffect(() => {
    setStorageBlocked(!testStorageWritable());
    setHostname(window.location.host);
    setPortfolio(loadPortfolio());
    const cached = loadCachedResult();
    if (cached) setResult(cached);
    setJournal(loadJournal());
    void refreshMarket();
    void fetch("/api/snapshot")
      .then((r) => r.json())
      .then((j) => {
        if (j?.snapshot?.collectedAt) setSnapshotTime(j.snapshot.collectedAt);
        if (j?.snapshot?.masterScore) setSnapshotMasterScore(j.snapshot.masterScore as MasterScore);
        if (j?.defaultPassword) setDefaultPassword(true);
      })
      .catch(() => {});
    const t = setInterval(() => void refreshMarket(), 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savePortfolio = useCallback((p: Portfolio) => {
    setPortfolio(p);
    persistPortfolio(p);
  }, []);

  async function refreshMarket() {
    try {
      const res = await fetch("/api/market", { cache: "no-store" });
      if (res.ok) setMarket((await res.json()) as MarketData);
    } catch {}
  }

  async function runDiagnosis() {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) setHealth((await res.json()) as Record<string, string>);
    } catch {}
  }

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    setNewsNotice(null);
    setHealth(null);
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    try {
      const res = await fetch("/api/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 평단가만 입력하고 수량은 아직 안 넣은 임시 항목(qty=0)은 "실제 보유"가 아니므로 서버에는 제외하고 보낸다.
        body: JSON.stringify({ portfolio: { ...portfolio, holdings: portfolio.holdings.filter((h) => h.qty > 0) } }),
      });
      let json: AdviceResponse | null = null;
      try {
        json = (await res.json()) as AdviceResponse;
      } catch {
        // 타임아웃 등으로 JSON이 아닌 응답이 온 경우
      }
      if (!res.ok || !json) {
        setError(
          json?.error ??
            `서버 응답 오류 (HTTP ${res.status}). 분석 시간이 초과되었을 수 있어요. 아래 자가 진단 결과를 확인해주세요.`,
        );
        void runDiagnosis();
      } else {
        setResult(json);
        persistResult(json);
        // 매매일지 — 이번 추천을 기록하고, 이전 추천들을 지금 가격으로 채점한다.
        // AI가 엔진과 다른 판단을 냈으면 화면에 보이는 쪽(AI)을 기록해야 성적표가 정직하다.
        {
          const prices: Record<string, number | null> = {};
          for (const sg of json.signals) prices[sg.ticker] = sg.price;
          const fresh = json.signals.map((sg) => {
            const a = json.advice?.stocks.find((x) => x.ticker === sg.ticker || x.ticker.includes(sg.ticker));
            return {
              ticker: sg.ticker,
              name: sg.name,
              action: (a?.action ?? sg.action) as string,
              price: sg.price,
              entryPrice: a?.entryPrice ?? sg.suggestedEntryPrice ?? null,
              targetPrice: a?.targetPrice ?? sg.targetPrice ?? null,
              stopPrice: a?.stopPrice ?? sg.stopPrice ?? null,
            };
          });
          const next = recordAndScore(loadJournal(), fresh, prices);
          saveJournal(next);
          setJournal(next);
        }
        setNewsNotice(!json.newsLive && json.newsError ? "지금은 실시간 속보 대신 최근 자동수집된 뉴스를 보여드리고 있어요 (일시적인 수집 지연)." : null);
        if (!json.advice && json.adviceError) {
          setError(`AI 종합 판단 실패: ${json.adviceError}`);
          void runDiagnosis();
        }
      }
    } catch {
      setError("네트워크 오류 또는 응답 시간 초과입니다. 아래 자가 진단 결과를 확인해주세요.");
      void runDiagnosis();
    } finally {
      clearInterval(timer);
      setLoading(false);
    }
  }

  const usdKrwRate = (market?.macro as Record<string, Quote | null> | undefined)?.usdkrw?.price ?? null;
  const toKrw = useCallback((usd: number) => (usdKrwRate ? usd * usdKrwRate : 0), [usdKrwRate]);

  // 국내(원화)/미국(달러) 보유 평가금을 각각 따로 집계한 뒤, 화면 최상단 "총 자산"에서만
  // 실시간 환율로 원화 환산해 하나의 숫자로 합친다 — 종목 카드 등 개별 표시는 항상 그 종목의
  // 원래 통화(원/달러)로 보여줘야 하므로 여기서 미리 환산해버리지 않는다.
  const holdingsValueKRW = useMemo(() => {
    let sum = 0;
    for (const h of portfolio.holdings) {
      if (STOCKS[h.ticker].currency !== "KRW") continue;
      const q = market?.quotes?.[h.ticker];
      sum += h.qty * (q?.price ?? h.avgPrice);
    }
    return sum;
  }, [portfolio, market]);

  const holdingsValueUSD = useMemo(() => {
    let sum = 0;
    for (const h of portfolio.holdings) {
      if (STOCKS[h.ticker].currency !== "USD") continue;
      const q = market?.quotes?.[h.ticker];
      sum += h.qty * (q?.price ?? h.avgPrice);
    }
    return sum;
  }, [portfolio, market]);

  const investedCostKRW = useMemo(
    () => portfolio.holdings.filter((h) => STOCKS[h.ticker].currency === "KRW").reduce((a, h) => a + h.qty * h.avgPrice, 0),
    [portfolio],
  );
  const investedCostUSD = useMemo(
    () => portfolio.holdings.filter((h) => STOCKS[h.ticker].currency === "USD").reduce((a, h) => a + h.qty * h.avgPrice, 0),
    [portfolio],
  );

  const holdingsValue = holdingsValueKRW + toKrw(holdingsValueUSD); // 원화 환산 합계 (총 자산 카드 전용)
  const investedCost = investedCostKRW + toKrw(investedCostUSD);
  const totalAsset = portfolio.cash + toKrw(portfolio.cashUSD) + holdingsValue;
  const totalPnl = holdingsValue - investedCost;
  const totalPnlPct = investedCost > 0 ? (totalPnl / investedCost) * 100 : 0;

  const macroChips: { key: string; label: string }[] = [
    { key: "usdkrw", label: "원/달러" },
    { key: "kospi", label: "코스피" },
    { key: "sox", label: "美반도체" },
    { key: "nasdaq", label: "나스닥" },
    { key: "spFutures", label: "S&P선물" },
    { key: "nasdaqFutures", label: "나스닥선물" },
    { key: "vix", label: "VIX" },
    { key: "oil", label: "WTI유가" },
    { key: "nikkei", label: "니케이" },
    { key: "shanghai", label: "상해" },
  ];

  const fearGreed = (market?.macro as { fearGreed?: { value: number; ratingKo: string } } | undefined)?.fearGreed;

  // 뉴스 집계 — 개별 기사를 하나씩 읽고 인상으로 판단하면 오판한다.
  // 몇 건이 어느 축(업황/지정학/중국/실적/큰손/매크로/지수)에 몰려 있는지를 먼저 본다.
  const newsSignal = useMemo(() => computeNewsSignal(result?.news ?? []), [result]);

  // 추적종목 전체 중 "지금 뭘 해야 하나"를 강도순으로 정렬한 요약 — 화면 맨 위에서 바로 판단할 수 있게
  const summaryRows = useMemo(() => {
    if (!result) return [];
    return TICKERS.map(({ ticker, name }) => {
      const sig = result.signals.find((s) => s.ticker === ticker);
      const ai = result.advice?.stocks.find((s) => s.ticker === ticker || s.ticker.includes(ticker));
      const h = portfolio.holdings.find((x) => x.ticker === ticker);
      const held = Boolean(h && h.qty > 0);
      const info = computeScoreInfo(held, sig, ai);
      return { ticker, name, held, info };
    })
      .filter((r) => r.info != null)
      .sort((a, b) => (b.info!.score ?? 0) - (a.info!.score ?? 0));
  }, [result, portfolio]);

  // 자동수집(GitHub Actions, 15분 간격)이 멈추면 스냅샷이 며칠 전 것일 수 있다.
  // 시:분만 보여주면 사용자는 당연히 "오늘"로 읽는다 — 며칠 전 매수 매력도를 오늘 것으로
  // 믿고 주문하는 상황을 막기 위해 경과 시간을 명시하고, 하루가 넘으면 아예 쓰지 않는다.
  const snapshotAgeH = snapshotTime ? (Date.now() - new Date(snapshotTime).getTime()) / 3_600_000 : null;
  const snapshotStale = snapshotAgeH != null && snapshotAgeH > 2;
  const snapshotUnusable = snapshotAgeH != null && snapshotAgeH > 24;
  const snapshotLabel =
    snapshotAgeH == null
      ? null
      : snapshotAgeH < 1
        ? `자동수집 ${Math.max(1, Math.round(snapshotAgeH * 60))}분 전`
        : snapshotAgeH < 24
          ? `자동수집 ${Math.round(snapshotAgeH)}시간 전`
          : `⚠ ${Math.floor(snapshotAgeH / 24)}일째 갱신 멈춤`;

  // "AI 정밀 분석"을 누르기 전에는 자동수집 스냅샷의 마스터 스코어를, 누른 뒤에는 방금 계산된 것을 보여준다.
  // 단 하루 넘게 갱신되지 않은 스냅샷은 오늘의 판단 근거가 될 수 없으므로 아예 보여주지 않는다.
  const displayMasterScore = result?.masterScore ?? (snapshotUnusable ? null : snapshotMasterScore);
  const masterScoreIsLive = Boolean(result?.masterScore);

  return (
    <main className="container">
      {/* 헤더 — 예전에는 제목·부제·접속주소·버튼 2개가 첫 화면의 1/4을 먹었다.
          토스처럼 "지금 필요한 것"만 남기고 나머지는 설정 시트로 내렸다. */}
      <div className="header">
        <div className="hd-left">
          <h1>내 주식 비서</h1>
          {snapshotLabel && (
            <span className={snapshotStale ? "hd-chip hd-chip-stale" : "hd-chip"}>
              {snapshotLabel.replace("자동수집 ", "")}
            </span>
          )}
        </div>
        <button className="hd-icon" onClick={() => setSettingsOpen((v) => !v)} aria-label="설정">
          ⚙️
        </button>
      </div>

      {/* 설정 — 자주 쓰지 않는 것은 전부 여기로. 기본은 닫혀 있다. */}
      {settingsOpen && (
        <div className="card set-sheet">
          <button className="set-row" onClick={() => { setEditOpen(true); setSettingsOpen(false); }}>
            <span>💰 내 자산 입력</span><span className="set-arrow">›</span>
          </button>
          <button className="set-row" onClick={() => { void runDiagnosis(); setSettingsOpen(false); }}>
            <span>🔍 연결 상태 확인</span><span className="set-arrow">›</span>
          </button>
          <button
            className="set-row"
            onClick={async () => {
              await fetch("/api/auth", { method: "DELETE" });
              window.location.href = "/login";
            }}
          >
            <span>🚪 로그아웃</span><span className="set-arrow">›</span>
          </button>
          <div className="set-meta">
            추적 종목 10개 (반도체 5 + 비반도체 5){hostname ? ` · ${hostname}` : ""}
          </div>
        </div>
      )}

      {/* 저장소 자가진단 — localStorage 쓰기/읽기가 실패하면 자산정보·분석결과가 계속 초기화되는데,
          원인이 조용히 묻히지 않도록 화면에 명확히 알려준다 */}
      {/* 경고는 한 줄로 접어둔다 — 중요하지만 이 앱의 목적이 아니다.
          예전에는 이 박스 하나가 첫 화면의 40%를 먹어 정작 "오늘 뭘 할지"가 밀려났다. */}
      {defaultPassword && (
        <details className="warn-chip">
          <summary>🔓 기본 비밀번호로 열려 있어요 — 설정 방법 보기</summary>
          <div className="warn-body">
            이 비밀번호는 공개된 소스코드에 적혀 있어 실질적인 보호가 되지 않습니다.
            주소를 아는 사람이 <strong>내 보유 종목과 수량</strong>을 볼 수 있어요.
            <ol className="warn-list">
              <li>Vercel → 이 프로젝트 → Settings → Environment Variables</li>
              <li><strong>APP_PASSWORD</strong>에 나만 아는 비밀번호를 추가</li>
              <li>Deployments에서 최신 배포를 Redeploy</li>
            </ol>
          </div>
        </details>
      )}

      {storageBlocked && (
        <details className="warn-chip">
          <summary>⚠️ 저장이 차단돼 자산 정보가 계속 지워져요 — 해결 방법</summary>
          <div className="warn-body">
            <ol className="warn-list">
              <li>시크릿 모드로 열려 있지 않은지 확인 (탭을 닫으면 데이터가 사라집니다)</li>
              <li>크롬 설정 → 사이트 설정 → 쿠키에서 이 사이트가 차단됐는지 확인</li>
              <li>휴대폰 저장공간 확보</li>
              <li>배터리·메모리 최적화 대상에서 이 앱(또는 크롬) 제외</li>
            </ol>
          </div>
        </details>
      )}

      {/* 글자 크기 조절 — 가- / 가+ 로 전체 화면 글자 크기를 바꿀 수 있다 (다음에 켜도 유지됨) */}
      {/* ===== 탭: 오늘 ===== */}
      <div style={{ display: tab === "오늘" ? undefined : "none" }}>

      {/* 하루 손실 한도 — "멈추라"는 신호는 "무엇을 사라"보다 먼저 와야 한다.
          종목별 1% 규칙만으로는 여러 종목이 같은 날 무너지는 상황을 못 막는다(반도체 상관 0.89). */}
      {result?.dailyRisk && (result.dailyRisk.stopTriggered || result.dailyRisk.warnTriggered) && (
        <div className={result.dailyRisk.stopTriggered ? "dstop dstop-hit" : "dstop dstop-warn"}>
          <div className="dstop-h">
            {result.dailyRisk.stopTriggered ? "🛑" : "⚠️"} {result.dailyRisk.headline}
          </div>
          <div className="dstop-b">{result.dailyRisk.detail}</div>
        </div>
      )}

      {/* ⭐ 오늘 나의 행동 — 이 앱에서 가장 먼저, 가장 크게 보여야 하는 것.
          "사라는 건지 팔라는 건지 홀딩인지 판단이 안 선다"는 피드백을 반영해,
          아래 모든 카드보다 위에 종목별로 딱 한 줄씩 결론만 보여준다. */}
      {result?.signals && result.signals.length > 0 && (
        <div className="doit">
          <div className="doit-title">오늘 나의 행동</div>
          {(() => {
            const rows = result.signals.map((sg) => {
              const ai = result.advice?.stocks.find((x) => x.ticker === sg.ticker || x.ticker.includes(sg.ticker));
              const act = (ai?.action ?? sg.action) as string;
              const hold = portfolio.holdings.find((x) => x.ticker === sg.ticker && x.qty > 0);
              const cur = STOCKS[sg.ticker].currency;
              const px = (v: number | null | undefined) => (v == null ? "" : fmt(v, cur));
              // 우선순위: 팔 것 → 살 것 → 들고 있을 것 → 안 건드릴 것
              //
              // 매도 문구는 반드시 "실제로 보유 중일 때"만 낸다. 보유하지 않은 종목에
              // "지금 파세요 · 보유 0주"를 띄우면 초보 사용자는 공매도로 오해하거나
              // 자기가 뭘 갖고 있는지 헷갈린다(QA에서 실제로 발생). 미보유 + 매도신호는
              // "지금은 사지 마세요"가 올바른 번역이다.
              const lv = sg.forecastPath?.orderLevels;
              const isSell = act === "손절" || act === "전량매도" || act === "부분매도";
              if (isSell && hold) {
                if (act === "부분매도")
                  return { rank: 1, kind: "sell", name: sg.name, verb: "절반 파세요", detail: `보유 ${hold.qty}주 중 ${Math.max(1, Math.floor(hold.qty / 2))}주 · ${px(ai?.targetPrice ?? sg.targetPrice)} 부근` };
                return { rank: 0, kind: "sell", name: sg.name, verb: "지금 파세요", detail: `보유 ${hold.qty}주 전량 · ${px(ai?.stopPrice ?? sg.stopPrice)} 아래면 즉시` };
              }
              if (isSell)
                return { rank: 4, kind: "avoid", name: sg.name, verb: "사지 마세요", detail: "떨어지는 흐름이라 지금 새로 들어갈 자리가 아닙니다 (보유분 없음)" };
              if (act === "신규매수" || act === "추가매수") {
                const qty = sg.suggestedQty && sg.suggestedQty > 0 ? `${sg.suggestedQty}주` : "수량은 종목 탭 참고";
                return { rank: 2, kind: "buy", name: sg.name, verb: hold ? "더 사세요" : "사세요", detail: `${px(ai?.entryPrice ?? sg.suggestedEntryPrice)} · ${qty} · 손절 ${px(ai?.stopPrice ?? sg.stopPrice)}` };
              }
              if (hold)
                return { rank: 3, kind: "hold", name: sg.name, verb: "그대로 두세요", detail: `보유 ${hold.qty}주 · ${px(ai?.stopPrice ?? sg.stopPrice)} 깨지면 그때 파세요` };
              return { rank: 5, kind: "wait", name: sg.name, verb: "기다리세요", detail: lv ? `${px(lv.buyPrice)}까지 내려오면 그때 검토 (오늘 닿을 확률 ${lv.buyProbPct}%)` : "지금은 살 이유가 없습니다" };
            }).sort((a, b) => a.rank - b.rank);
            const act = rows.filter((r) => r.rank <= 3);
            const wait = rows.filter((r) => r.rank >= 4);
            return (
              <>
                {act.map((r) => (
                  <div className={`doit-row doit-${r.kind}`} key={r.name}>
                    <span className="doit-verb">{r.verb}</span>
                    <span className="doit-name">{r.name}</span>
                    <span className="doit-detail">{r.detail}</span>
                  </div>
                ))}
                {act.length === 0 && <div className="doit-row doit-wait"><span className="doit-verb">오늘은 쉬세요</span><span className="doit-detail">지금 사거나 팔 이유가 있는 종목이 없습니다</span></div>}
                {wait.length > 0 && (
                  <details className="doit-more">
                    <summary>지금 건드릴 필요 없는 종목 {wait.length}개 보기</summary>
                    {wait.map((r) => (
                      <div className={`doit-row doit-${r.kind}`} key={r.name}>
                        <span className="doit-verb">{r.verb}</span>
                        <span className="doit-name">{r.name}</span>
                        <span className="doit-detail">{r.detail}</span>
                      </div>
                    ))}
                  </details>
                )}
                <div className="doit-foot">
                  주문은 증권사 앱에서 직접 넣으세요 · <b>얼마에·얼마나·어디서 자를지</b>만 말합니다
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* 오늘의 작전 — 엔진이 장세(폭락장/급등과열/변동성확대/보통)를 스스로 판별해 그날의 플레이북 제시 */}
      {/* 오늘의 작전 — 예전에는 이 카드 하나가 1,056px로 오늘 탭의 80%를 먹었다.
          "지금 어떤 장이고 무엇을 조심할지" 두 줄만 남기고 나머지는 탭하면 나오게 접었다. */}
      {result?.todayPlan && (
        <details className={`plan-card plan-${result.todayPlan.regime}`}>
          <summary className="plan-sum">
            <span className={`plan-badge plan-badge-${result.todayPlan.regime}`}>{result.todayPlan.regime}</span>
            <span className="plan-sum-note">{result.todayPlan.regimeNote}</span>
          </summary>
          <div className="plan-market-note">{result.todayPlan.marketNote}</div>
          {/* 보유 vs 트레이딩 — 단타를 권하기 전에 "지금 사고파는 게 유리한 국면인가"부터 알린다 */}
          {result.todayPlan.holdEdge?.available && (
            <div className={`plan-edge plan-edge-${result.todayPlan.holdEdge.verdict}`}>
              <div className="plan-edge-title">
                {result.todayPlan.holdEdge.verdict === "보유우위" ? "🏆 지금은 '보유'가 유리했던 국면" :
                 result.todayPlan.holdEdge.verdict === "장중우위" ? "⚡ 지금은 '장중 매매'가 유리했던 국면" : "⚖️ 보유·매매 우열이 뚜렷하지 않은 국면"}
              </div>
              <div className="plan-edge-bars">
                <div><span>밤사이 갭</span><strong>{result.todayPlan.holdEdge.overnightPct >= 0 ? "+" : ""}{result.todayPlan.holdEdge.overnightPct.toFixed(0)}%p</strong></div>
                <div><span>장중(시가→종가)</span><strong>{result.todayPlan.holdEdge.intradayPct >= 0 ? "+" : ""}{result.todayPlan.holdEdge.intradayPct.toFixed(0)}%p</strong></div>
              </div>
              <div className="plan-edge-note">{result.todayPlan.holdEdge.note}</div>
            </div>
          )}
          {/* 국면별 조건부 전망 — 여러 장세를 뭉갠 평균이 아니라 "지금과 같은 상태"의 과거 기록 */}
          {result.todayPlan.scenarios.length > 0 && (
            <div className="plan-scen">
              <button className="plan-why" onClick={() => setOpenWhy((v) => ({ ...v, __scen: !v.__scen }))}>
                {openWhy.__scen ? "국면 분석 접기 ▲" : `📐 지금 국면과 과거 통계 보기 (${result.todayPlan.scenarios[0].label}) ▼`}
              </button>
              {openWhy.__scen && (
                <div className="plan-scen-body">
                  {Array.from(new Set(result.todayPlan.scenarios.map((sc) => sc.note))).map((note, i) => (
                    <div className="plan-scen-item" key={i}>{note}</div>
                  ))}
                  <div className="plan-scen-foot">
                    같은 국면으로 분류된 과거 시점들의 실제 기록입니다. 미래 예측이 아니며, AI 업황 둔화·전쟁·환율 같은
                    구조적 리스크는 과거 통계에 반영돼 있지 않습니다.
                  </div>
                </div>
              )}
            </div>
          )}
          {result.todayPlan.trades.map((t, ti) => (
            <div className="plan-trade" key={ti}>
              <div className="plan-trade-head">
                <strong>{t.name}</strong>
                <span className="plan-kind">{t.kind}</span>
              </div>
              <div className="plan-headline">👉 {t.headline}</div>
              {t.kind === "눌림목매수" && t.entryPrice != null && (
                <div className="genius-prices">
                  <div><span>진입(지정가)</span><strong>{fmt(t.entryPrice, t.currency)}</strong></div>
                  <div><span>익절</span><strong style={{ color: "#1b64da" }}>{fmt(t.targetPrice, t.currency)}</strong></div>
                  <div><span>손절(필수)</span><strong style={{ color: "#c9353f" }}>{fmt(t.stopPrice, t.currency)}</strong></div>
                </div>
              )}
              {t.suggestedQty != null && (
                <div className="plan-qty">
                  수량 {t.suggestedQty.toLocaleString()}주
                  {t.suggestedBudget != null && ` (약 ${manwon(t.suggestedBudget)})`}
                </div>
              )}
              {/* 안전에 직결되는 첫 경고는 항상 보이고, 통계 근거와 나머지 주의는 접어둔다 —
                  화면에서 "지금 뭘 하라"가 먼저 읽히도록 */}
              {t.cautions[0] && <div className="plan-caution">⚠️ {t.cautions[0]}</div>}
              <button className="plan-why" onClick={() => setOpenWhy((v) => ({ ...v, [t.ticker + t.kind]: !v[t.ticker + t.kind] }))}>
                {openWhy[t.ticker + t.kind] ? "근거 접기 ▲" : "왜 이 판단인가? (검증 통계 보기) ▼"}
              </button>
              {openWhy[t.ticker + t.kind] && (
                <>
                  <div className="plan-rationale">{t.rationale}</div>
                  {t.cautions.slice(1).map((c, ci) => (
                    <div className="plan-caution" key={ci}>⚠️ {c}</div>
                  ))}
                </>
              )}
            </div>
          ))}
          {result.todayPlan.holderGuide.length > 0 && (
            <div className="plan-holder">
              <div className="plan-holder-title">보유 중이라면</div>
              {result.todayPlan.holderGuide.map((g, gi) => (
                <div className="plan-holder-item" key={gi}>· {g}</div>
              ))}
            </div>
          )}
          {result.todayPlan.skippedNote && <div className="plan-skipped">{result.todayPlan.skippedNote}</div>}
        </details>
      )}

      {/* 마스터 스코어: 추적종목 전체+매크로 종합 "오늘의 매수 매력도" — AI 호출 없이 항상 즉시 계산됨 */}
      {displayMasterScore && (
        <div className={`card master-score master-score-${displayMasterScore.tone}`}>
          <div className="master-score-top">
            <div className="master-score-label">오늘의 매수 매력도{!masterScoreIsLive && " (자동수집 기준)"}</div>
            <div className="master-score-pct">{displayMasterScore.attractivenessPct}%</div>
          </div>
          <div className="master-score-tag">{displayMasterScore.label}</div>
          <div className="master-score-headline">{displayMasterScore.headline}</div>
        </div>
      )}

      </div>{/* ===== /탭: 오늘 1구간 ===== */}

      {/* ===== 탭: 종목 ===== */}
      <div style={{ display: tab === "종목" ? undefined : "none" }}>
      {/* 총 자산 — 원화+달러 보유를 실시간 환율로 환산해 하나의 숫자로 합산 */}
      <div className="card asset-card">
        <div className="asset-label">내 자산</div>
        <div className="asset-total">{won(totalAsset)}원</div>
        {investedCost > 0 && (
          <div className={`asset-pnl ${pctClass(totalPnl)}`}>
            {totalPnl >= 0 ? "+" : ""}{won(totalPnl)}원 ({totalPnlPct >= 0 ? "+" : ""}{totalPnlPct.toFixed(1)}%)
          </div>
        )}
        {/* 세부 내역은 접어둔다 — 큰 숫자 하나가 먼저 눈에 들어와야 한다 */}
        <details className="asset-more">
          <summary>내역</summary>
          <div className="asset-more-row"><span>현금</span><b>{won(portfolio.cash)}원{portfolio.cashUSD > 0 && ` + $${won(portfolio.cashUSD)}`}</b></div>
          <div className="asset-more-row"><span>주식</span><b>{won(holdingsValueKRW)}원{holdingsValueUSD > 0 && ` + $${won(holdingsValueUSD)}`}</b></div>
          {investedCost > 0 && <div className="asset-more-row"><span>산 가격 합계</span><b>{won(investedCost)}원</b></div>}
        </details>
        {!usdKrwRate && (portfolio.cashUSD > 0 || holdingsValueUSD > 0) && (
          <div className="hint" style={{ color: "var(--red)" }}>
            환율을 아직 못 가져와 달러 자산이 빠져 있어요 (잠시 후 자동 갱신).
          </div>
        )}
      </div>

      {/* 종합 리포트 — 카드가 흩어져 있으면 "그래서 지금 내 계좌 상태가 어떻다는 건가"를
          한눈에 알 수 없다. 보유 판단 분포와 위험을 한 카드에 모은다. */}
      {result && portfolio.holdings.some((x) => x.qty > 0) && (() => {
        const mine = portfolio.holdings
          .filter((x) => x.qty > 0)
          .map((x) => {
            const sg = result.signals.find((v) => v.ticker === x.ticker);
            const av = result.advice?.stocks.find((v) => v.ticker === x.ticker || v.ticker.includes(x.ticker));
            return { h: x, sig: sg, verdict: holdVerdict(av?.action ?? sg?.action) };
          });
        const cnt = (c: HoldChoice) => mine.filter((m) => m.verdict.choice === c).length;
        return (
          <div className="card rep">
            <div className="rep-title">📊 오늘 내 계좌 리포트</div>
            <div className="rep-grid">
              {HOLD_CHOICES.map((c) => (
                <div key={c} className={`rep-cell${cnt(c) > 0 ? ` on rep-${c === "팔기" ? "sell" : c === "더 사기" ? "buy" : "keep"}` : ""}`}>
                  <b>{cnt(c)}</b>
                  <span>{c}</span>
                </div>
              ))}
            </div>
            {result.dailyRisk && (
              <div className="rep-row">
                <span>오늘 손익</span>
                <b className={result.dailyRisk.todayPnlWon >= 0 ? "up" : "down"}>
                  {result.dailyRisk.todayPnlWon >= 0 ? "+" : ""}{won(result.dailyRisk.todayPnlWon)}원 ({result.dailyRisk.todayPnlPct >= 0 ? "+" : ""}{result.dailyRisk.todayPnlPct}%)
                </b>
              </div>
            )}
            {result.portfolioRisk && (
              <>
                <div className="rep-row">
                  <span>하루 흔들리는 폭</span>
                  <b>±{manwon(result.portfolioRisk.sigmaDailyAmount)}</b>
                </div>
                <div className="rep-row">
                  <span>100일에 한 번 오는 최악</span>
                  <b className="down">{manwon(result.portfolioRisk.loss1Pct)}</b>
                </div>
              </>
            )}
            <details className="rep-more">
              <summary>자세한 위험 지표</summary>
              {result.portfolioRisk && (
                <>
                  <div className="rep-row"><span>20일에 한 번 나쁜 날</span><b className="down">{manwon(result.portfolioRisk.loss5Pct)}</b></div>
                  <div className="rep-row"><span>실질 분산 효과</span><b>{result.portfolioRisk.effectiveBets.toFixed(1)}종목</b></div>
                  <div className="rep-row"><span>상관 무시 시 과소평가</span><b>{result.portfolioRisk.naiveUnderestimatePct}%</b></div>
                </>
              )}
              {result.portfolioRisk?.warnings.map((w, i) => <div className="rep-warn" key={`pr${i}`}>{w}</div>)}
              {result.sectorConcentrationWarning && <div className="rep-warn">{result.sectorConcentrationWarning}</div>}
              {result.correlationCap?.warnings.map((w, i) => <div className="rep-warn" key={`cc${i}`}>{w}</div>)}
              <div className="rep-note">
                과거 5년 실데이터로 검증한 추정치입니다(90% 구간 적중률 약 88%).
                확정 예측이 아니라 &quot;이 정도 범위는 각오해야 한다&quot;는 기준으로만 쓰세요.
              </div>
            </details>
          </div>
        );
      })()}


      {/* 자산 입력 */}
      {editOpen && (
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 6 }}>내 자산 입력</div>
          <div className="input-row">
            <label>보유 현금</label>
            <input
              type="text"
              inputMode="numeric"
              value={portfolio.cash.toLocaleString("ko-KR")}
              onChange={(e) => {
                const v = Number(e.target.value.replace(/[^0-9]/g, ""));
                savePortfolio({ ...portfolio, cash: isNaN(v) ? 0 : v });
              }}
            />
            <span className="input-suffix">원</span>
          </div>
          {/* 달러현금 입력은 추적 종목에 달러 종목이 있을 때만 의미가 있다. 지금은 전 종목이
              원화라 기본적으로 숨기되, 예전에 입력해둔 잔액이 남아 있으면 지울 수 있게 보여준다
              (숨기기만 하면 총자산에 계속 반영되는데 손댈 방법이 없어진다). */}
          {(TICKERS.some(({ ticker }) => STOCKS[ticker].currency === "USD") || portfolio.cashUSD > 0) && (
            <div className="input-row">
              <label>보유 달러현금</label>
              <input
                type="text"
                inputMode="decimal"
                value={portfolio.cashUSD.toLocaleString("en-US")}
                onChange={(e) => {
                  const v = Number(e.target.value.replace(/[^0-9.]/g, ""));
                  savePortfolio({ ...portfolio, cashUSD: isNaN(v) ? 0 : v });
                }}
              />
              <span className="input-suffix">$</span>
            </div>
          )}
          {TICKERS.map(({ ticker, name }) => {
            const currency = STOCKS[ticker].currency;
            const h = portfolio.holdings.find((x) => x.ticker === ticker);
            const update = (avgPrice: number, qty: number) => {
              const rest = portfolio.holdings.filter((x) => x.ticker !== ticker);
              // qty가 아직 0이어도(평단가만 먼저 입력한 상태) 항목을 유지해야 입력값이 화면에서
              // 사라지지 않는다 — "실제 보유중"인지는 소비하는 쪽에서 항상 qty>0으로 별도 판단한다.
              const next =
                avgPrice > 0 || qty > 0 ? [...rest, { ticker, avgPrice, qty }] : rest;
              savePortfolio({ ...portfolio, holdings: next });
            };
            return (
              <div key={ticker} style={{ marginTop: 18 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{name}</div>
                <div className="input-row">
                  <label>매수 평단가</label>
                  <input
                    type="text"
                    inputMode={currency === "USD" ? "decimal" : "numeric"}
                    placeholder="0"
                    value={h ? h.avgPrice.toLocaleString(currency === "USD" ? "en-US" : "ko-KR") : ""}
                    onChange={(e) => {
                      const v = Number(e.target.value.replace(currency === "USD" ? /[^0-9.]/g : /[^0-9]/g, ""));
                      update(isNaN(v) ? 0 : v, h?.qty ?? 0);
                    }}
                  />
                  <span className="input-suffix">{currency === "USD" ? "$" : "원"}</span>
                </div>
                <div className="input-row">
                  <label>보유 수량</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="0 (없으면 비워두세요)"
                    value={h ? h.qty.toLocaleString("ko-KR") : ""}
                    onChange={(e) => {
                      const v = Number(e.target.value.replace(/[^0-9]/g, ""));
                      update(h?.avgPrice ?? 0, isNaN(v) ? 0 : v);
                    }}
                  />
                  <span className="input-suffix">주</span>
                </div>
              </div>
            );
          })}
          <div className="hint">입력한 정보는 이 휴대폰/브라우저에만 저장됩니다. 서버에 저장되지 않아요.</div>
        </div>
      )}

      </div>{/* ===== /탭: 종목 1구간 ===== */}

      {/* ===== 탭: 정보 ===== */}
      <div style={{ display: tab === "정보" ? undefined : "none" }}>
      {/* 장 상태(국내/미국) + 상대강도 + 섹터집중도 배너 */}
      {result?.marketPhase && (
        <div className="phase-banner">
          <span className="phase-tag">국내 {result.marketPhase.phase}</span>
          <span className="phase-time">{result.marketPhase.kstTime} KST</span>
          <span className="phase-note">{result.marketPhase.note}</span>
        </div>
      )}
      {result?.marketPhaseUS && (
        <div className="phase-banner">
          <span className="phase-tag">미국 {result.marketPhaseUS.phase}</span>
          <span className="phase-time">{result.marketPhaseUS.kstTime} KST</span>
          <span className="phase-note">{result.marketPhaseUS.note}</span>
        </div>
      )}
      {result?.relativeStrengthSummary && (
        <div className="rs-banner">
          {result.relativeStrengthSummary.split("\n").map((line, i) => (
            <div key={i}>⚖️ {line}</div>
          ))}
        </div>
      )}
      <div className="font-size-row">
        <span className="font-size-label">글자 크기</span>
        <div className="font-size-controls">
          <button
            className="font-size-btn"
            aria-label="글자 작게"
            disabled={fontScaleIdx === 0}
            onClick={() => setFontScaleIdx((i) => Math.max(0, i - 1))}
          >
            가<span style={{ fontSize: "0.7em" }}>−</span>
          </button>
          <span className="font-size-current">{FONT_SCALE_LABELS[fontScaleIdx]}</span>
          <button
            className="font-size-btn"
            aria-label="글자 크게"
            disabled={fontScaleIdx === FONT_SCALE_STEPS.length - 1}
            onClick={() => setFontScaleIdx((i) => Math.min(FONT_SCALE_STEPS.length - 1, i + 1))}
          >
            가<span style={{ fontSize: "1.25em" }}>+</span>
          </button>
        </div>
      </div>

      {/* 매크로 스트립 */}
      <div className="macro-strip">
        {macroChips.map(({ key, label }) => {
          const q = (market?.macro as Record<string, Quote | null> | undefined)?.[key];
          return (
            <div className="macro-chip" key={key}>
              <div className="name">{label}</div>
              <div className="val">{q ? q.price.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "-"}</div>
              <div className={`pct ${pctClass(q?.changePct)}`}>
                {q ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%` : ""}
              </div>
            </div>
          );
        })}
        {fearGreed && (
          <div className="macro-chip">
            <div className="name">공포탐욕지수</div>
            <div className="val" style={{ fontSize: 14 }}>{fearGreed.ratingKo}</div>
            <div className="pct flat">{fearGreed.value}/100</div>
          </div>
        )}
        {result?.signals?.[0] && (
          <div className="macro-chip">
            <div className="name">매크로 영향도</div>
            <div className="val" style={{ fontSize: 14 }}>
              {result.signals[0].macroScore > 0 ? "우호적" : result.signals[0].macroScore < 0 ? "비우호적" : "중립"}
            </div>
            <div className={`pct ${pctClass(result.signals[0].macroScore)}`}>
              {result.signals[0].macroScore >= 0 ? "+" : ""}
              {result.signals[0].macroScore}점
            </div>
          </div>
        )}
      </div>

      </div>{/* ===== /탭: 정보 1구간 ===== */}

      <div style={{ display: tab === "오늘" ? undefined : "none" }}>
      {/* 섹터집중도 경고 — 행동에 직접 영향을 주므로 '오늘' 탭에 남긴다 */}
      {result?.sectorConcentrationWarning && (
        <div className="rs-banner" style={{ background: "var(--red-weak)", color: "#c9353f" }}>
          🎯 {result.sectorConcentrationWarning}
        </div>
      )}

      {/* AI 분석 버튼 */}
      <button className="btn btn-primary" onClick={() => void runAnalysis()} disabled={loading} style={{ marginBottom: !loading && result ? 4 : 14 }}>
        {loading ? (
          <>
            <span className="spinner" />
            AI 분석 중… {elapsed}초 (보통 30초~2분 걸려요)
          </>
        ) : result ? (
          "다시 분석하기"
        ) : (
          "지금 AI 정밀 분석 받기"
        )}
      </button>
      {!loading && result && (
        <div className="hint" style={{ textAlign: "center", marginBottom: 14 }}>
          {staleness(result.generatedAt, "분석")}
        </div>
      )}
      {error && (
        <div className="card" style={{ color: "var(--red)", fontWeight: 700, fontSize: 14 }}>
          {error}
        </div>
      )}
      {!error && newsNotice && (
        <div className="card" style={{ color: "var(--text-sub)", fontSize: 13, fontWeight: 600 }}>
          ℹ️ {newsNotice}
        </div>
      )}
      {health && (
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 8, fontSize: 14 }}>🔍 자가 진단 결과</div>
          {Object.entries(health).map(([k, v]) => (
            <div className="kv-row" key={k}>
              <span className="k">{k.replace(/_/g, " ")}</span>
              <span className="v" style={{ fontSize: 12, textAlign: "right", maxWidth: "62%", fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
      )}

      {/* AI 종합 코멘트 */}
      {result?.advice && (
        <div className="ai-box">
          <div className="ai-label">AI 종합 판단 · 리스크 {result.advice.overall.riskLevel}</div>
          <div className="ai-headline">{result.advice.overall.headline}</div>
          <div className="ai-body">{result.advice.overall.marketComment}</div>
        </div>
      )}

      {/* 인사이트 분석 리포트 — 분석 버튼을 누를 때마다 여러 지표를 종합해 새로 생성되는 리포트 */}
      {result?.advice?.insightReport && (
        <>
          <div className="section-title">
            📋 오늘의 쉬운 해설 리포트
            <span className="meta">{new Date(result.advice.generatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 생성</span>
          </div>
          <div className="card insight-report">
            <div className="insight-section">
              <div className="insight-section-title">🧭 오늘 시장 분위기</div>
              <div className="insight-section-body">{result.advice.insightReport.marketRegime}</div>
            </div>
            <div className="insight-section">
              <div className="insight-section-title">📊 차트로 본 흐름</div>
              <div className="insight-section-body">{result.advice.insightReport.technicalSynthesis}</div>
            </div>
            <div className="insight-section">
              <div className="insight-section-title">💰 돈의 흐름과 뉴스 분위기</div>
              <div className="insight-section-body">{result.advice.insightReport.flowAndSentiment}</div>
            </div>
            <div className="insight-section insight-risk">
              <div className="insight-section-title">⚠️ 꼭 조심할 점</div>
              <div className="insight-section-body">{result.advice.insightReport.keyRisks}</div>
            </div>
            <div className="insight-section insight-action">
              <div className="insight-section-title">🎯 오늘 뭐부터 볼까</div>
              <div className="insight-section-body">{result.advice.insightReport.actionPlan}</div>
            </div>
          </div>
        </>
      )}
      {result && !result.aiAvailable && (
        <details className="warn-chip">
          <summary>ℹ️ AI 종합 판단이 꺼져 있어요 — 켜는 방법</summary>
          <div className="warn-body">
            지금은 계산 엔진의 신호만 보여드리고 있어요. Vercel 환경변수에 <strong>ANTHROPIC_API_KEY</strong>를
            추가하면 뉴스·공시까지 함께 읽는 AI 종합 판단이 켜집니다.
          </div>
        </details>
      )}

      {/* 지금 뭘 해야 하나 — 추적종목 전체 강도순 랭킹 (핵심 요약) */}
      {summaryRows.length > 0 && (
        <>
          <div className="section-title">지금 뭘 해야 하나</div>
          <div className="card">
            {summaryRows.map(({ ticker, name, held, info }) => (
              <div className="summary-row" key={ticker}>
                <div className="summary-name">
                  {name}
                  {held && <span className="held-tag">보유중</span>}
                </div>
                <div className="summary-action">{info!.oneLiner}</div>
                <div className={`summary-score-badge ${info!.tone}`}>
                  {info!.score}
                  <span className="denom">/10</span>
                </div>
              </div>
            ))}
            <div className="hint">
              미보유 종목은 매수 강도, 보유 종목은 매도 강도(단, 수익 중 추가매수 신호가 뜨면 추가매수 강도)입니다. 8점 이상이면 강한 신호, 4~7점은 조건부(트리거·목표가 확인), 0~3점은 아직 근거 부족(관망/보유)이에요.
            </div>
          </div>
        </>
      )}

      </div>{/* ===== /탭: 오늘 2구간 ===== */}

      <div style={{ display: tab === "정보" ? undefined : "none" }}>
      {/* 실시간 뉴스·속보 — 판단 근거를 바로 확인할 수 있도록 종목 카드보다 먼저 노출 */}
      {result && result.news.length > 0 && (
        <>
          <div className="section-title">
            뉴스 종합
            <span className="meta">{result.newsLive ? "실시간 수집" : "최근 자동수집분"}</span>
          </div>
          {/* 기사 하나하나를 읽고 인상으로 판단하면 오판한다. 먼저 "몇 건이 어느 쪽으로 쏠려 있나"를 본다. */}
          <div className="card">
            <div className={`nsig-tone ${newsSignal.pressure <= -0.6 ? "neg" : newsSignal.pressure >= 0.6 ? "pos" : "neu"}`}>
              {newsSignal.pressure <= -0.6 ? "악재가 우세합니다" : newsSignal.pressure >= 0.6 ? "호재가 우세합니다" : "호재와 악재가 섞여 있습니다"}
            </div>
            <div className="nsig-counts">
              <div><b>{newsSignal.collected}</b><span>수집</span></div>
              <div className="pos"><b>{newsSignal.positive}</b><span>호재</span></div>
              <div className="neg"><b>{newsSignal.negative}</b><span>악재</span></div>
              <div><b>{newsSignal.breaking}</b><span>속보</span></div>
              <div><b>{newsSignal.highImpact}</b><span>영향 큼</span></div>
            </div>
            {newsSignal.thin && (
              <div className="nsig-thin">⚠ 뉴스가 {newsSignal.collected}건뿐입니다. 이 정도 표본으로 시장 분위기를 단정하면 오판하기 쉬워, AI도 뉴스 근거의 비중을 낮춰 판단하도록 되어 있습니다.</div>
            )}
            {newsSignal.axes.length > 0 && (
              <div className="nsig-axes">
                {newsSignal.axes.map((a) => (
                  <div className="nsig-axis" key={a.axis}>
                    <div className="nsig-axis-h">
                      <span className="nsig-axis-n">{a.axis}</span>
                      <span className="nsig-axis-c">{a.total}건</span>
                      <span className={`nsig-axis-p ${a.pressure <= -0.3 ? "neg" : a.pressure >= 0.3 ? "pos" : "neu"}`}>
                        {a.pressure <= -0.3 ? `악재 ${a.negative}건 우위` : a.pressure >= 0.3 ? `호재 ${a.positive}건 우위` : "혼조"}
                      </span>
                    </div>
                    <div className="nsig-axis-note">{a.note}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="nsig-foot">
              축별로 나눠 보는 이유: 같은 &quot;악재&quot;라도 지정학은 지수 전체를, 중국 증설은 메모리 마진만 때립니다.
              어느 축에 쏠렸는지가 어느 종목이 흔들릴지를 정합니다.
            </div>
          </div>

          <details className="card news-raw">
            <summary className="news-raw-sum">기사 원문 {result.news.length}건 보기</summary>
            {result.news.map((n, i) => (
              <div className="news-item" key={i}>
                <div className="news-title">
                  {n.isBreaking && <span className="tag tag-breaking" style={{ marginRight: 6 }}>🔴 속보</span>}
                  {n.title}
                </div>
                <div className="news-summary">{n.summary}</div>
                <div className="news-meta">
                  <span className={`tag ${n.sentiment === "긍정" ? "tag-pos" : n.sentiment === "부정" ? "tag-neg" : "tag-neu"}`}>
                    {n.sentiment}
                  </span>
                  <span className="tag tag-neu">영향 {n.impact}</span>
                  <span>{n.relatedTo}</span>
                  {n.publishedAt && <span>· {n.publishedAt}</span>}
                  {n.source && <span>· {n.source}</span>}
                </div>
              </div>
            ))}
          </details>
        </>
      )}

      {/* 매매일지 — 이 앱 추천이 실제로 맞았는지. 피드백이 없으면 앱을 믿을 근거도 없다. */}
      {(() => {
        const js = summarize(journal);
        const recent = [...journal].reverse().slice(0, 12);
        if (journal.length === 0) return null;
        return (
          <>
            <div className="section-title">추천 성적표<span className="meta">이 기기에만 저장</span></div>
            <div className="card">
              <div className="jn-head">{js.headline}</div>
              {js.available && (
                <div className="jn-stats">
                  <div><b>{js.hitRatePct}%</b><span>방향 적중</span></div>
                  <div className={js.avgSignedPct >= 0 ? "pos" : "neg"}><b>{js.avgSignedPct >= 0 ? "+" : ""}{js.avgSignedPct}%</b><span>평균</span></div>
                  <div className="pos"><b>+{js.avgWinPct}%</b><span>맞았을 때</span></div>
                  <div className="neg"><b>{js.avgLossPct}%</b><span>틀렸을 때</span></div>
                  <div><b>{js.pending}</b><span>진행중</span></div>
                </div>
              )}
              {js.caution && <div className="jn-caution">{js.caution}</div>}
              <details className="jn-more">
                <summary>최근 추천 {recent.length}건 보기</summary>
                {recent.map((e) => (
                  <div className="jn-row" key={e.id}>
                    <span className="jn-date">{e.recommendedAt.slice(5, 10)}</span>
                    <span className="jn-name">{e.name}</span>
                    <span className="jn-act">{e.action}</span>
                    <span className={`jn-res ${!e.outcome || e.outcome.verdict === "진행중" ? "" : e.outcome.signedPct > 0 ? "pos" : "neg"}`}>
                      {!e.outcome || e.outcome.verdict === "진행중"
                        ? "진행중"
                        : `${e.outcome.verdict} ${e.outcome.signedPct >= 0 ? "+" : ""}${e.outcome.signedPct}%`}
                    </span>
                  </div>
                ))}
              </details>
            </div>
          </>
        );
      })()}

      {result?.advice && result.advice.newsHighlights.length > 0 && (
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 8, fontSize: 14 }}>AI가 뽑은 핵심 포인트</div>
          {result.advice.newsHighlights.map((h2, i) => (
            <div className="reason" key={i} style={{ marginBottom: 6 }}>
              {h2}
            </div>
          ))}
        </div>
      )}

      <div className="disclaimer">
        본 서비스는 투자 판단을 돕는 참고 정보이며, 투자 권유나 수익 보장이 아닙니다.
        <br />
        모든 투자의 최종 결정과 책임은 투자자 본인에게 있습니다. 단기 매매는 원금 손실 위험이 큽니다.
        <br />
        <strong>무료 공개 API 기반 시세는 최대 15~20분 지연될 수 있습니다.</strong> 실제 주문 직전에는 반드시 증권사 앱(MTS)에서 최신 호가를 확인하세요. 진입/무효화 조건은 고정 가격이 아니라 &quot;조건 충족 여부&quot;로 판단하도록 설계되어 지연의 영향을 줄였지만, 완전히 없앨 수는 없습니다.
        <br />
        목표가·손절가는 왕복 거래비용(증권거래세+수수료, 약 0.25%)을 반영하지 않은 값입니다. 실제 순수익은 표시된 수치보다 낮습니다.
      </div>
      </div>{/* ===== /탭: 정보 2구간 ===== */}

      <div style={{ display: tab === "종목" ? undefined : "none" }}>
      {/* 종목을 "내가 가진 것"과 "지켜보는 것"으로 나눈다.
          섞여 있으면 10개를 하나씩 확인해야 내 포지션을 파악할 수 있다. */}
      {portfolio.holdings.some((x) => x.qty > 0) && <div className="sec-h">내가 가진 종목</div>}
      {[...TICKERS]
        .sort((a, b) => {
          const ha = portfolio.holdings.some((x) => x.ticker === a.ticker && x.qty > 0) ? 0 : 1;
          const hb = portfolio.holdings.some((x) => x.ticker === b.ticker && x.qty > 0) ? 0 : 1;
          return ha - hb;
        })
        .map(({ ticker, name }, listIdx, arr) => {
        const currency = STOCKS[ticker].currency;
        const q = market?.quotes?.[ticker];
        const sig = result?.signals.find((s) => s.ticker === ticker);
        const ai = result?.advice?.stocks.find((s) => s.ticker === ticker || s.ticker.includes(ticker));
        const h = portfolio.holdings.find((x) => x.ticker === ticker);
        const held = Boolean(h && h.qty > 0);
        const action = ai?.action ?? sig?.action;
        const info = computeScoreInfo(held, sig, ai);
        const isOpen = expanded.has(ticker);
        // 기본은 전부 접어둔다. 예전에는 보유·신호 종목을 자동으로 펼쳐서
        // 종목 탭이 6,000px을 넘었다 — 스크롤 지옥의 원인이었다.
        // "무엇을 할지"는 오늘 탭의 행동 카드가 이미 말해주므로, 여기는 훑어보는 목록이면 된다.
        const open = cardOpen[ticker] ?? false;
        // 한 줄 요약 — 접힌 상태에서 딱 이만큼만 보인다.
        // 배지(행동)와 어긋나면 안 된다: "손절" 배지 옆에 "매수 검토" 문구가 붙으면 초보자는 혼란만 겪는다.
        const sellish = action === "손절" || action === "전량매도" || action === "부분매도";
        const oneLine = held && h
          ? `${h.qty}주 보유${sig?.pnlPct != null ? ` · ${sig.pnlPct >= 0 ? "+" : ""}${sig.pnlPct}%` : ""}`
          : sellish
            ? "지금 새로 살 자리는 아니에요"
            : sig?.forecastPath?.orderLevels
              ? `${fmt(sig.forecastPath.orderLevels.buyPrice, currency)}까지 오면 검토`
              : null;
        // 보유 → 관심 종목으로 넘어가는 첫 종목 앞에 구분 제목을 넣는다
        const prevHeld = listIdx > 0 && portfolio.holdings.some((x) => x.ticker === arr[listIdx - 1].ticker && x.qty > 0);
        const showWatchHeading = !held && (listIdx === 0 || prevHeld);
        return (
          <Fragment key={ticker}>
          {showWatchHeading && <div className="sec-h">지켜보는 종목</div>}
          <div className={open ? "card stock-card open" : "card stock-card"}>
            {/* 행 전체가 버튼 — 토스처럼 어디를 눌러도 열린다 */}
            <button
              className="stock-row"
              aria-expanded={open}
              onClick={() => setCardOpen((p) => ({ ...p, [ticker]: !open }))}
            >
              <span className="sr-main">
                <span className="sr-name">{name}</span>
                {oneLine && <span className="sr-sub">{oneLine}</span>}
              </span>
              <span className="sr-right">
                <span className="sr-price">{fmt(q?.price ?? sig?.price, currency)}</span>
                <span className={`sr-chg ${pctClass(q?.changePct)}`}>
                  {q ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(1)}%` : "—"}
                </span>
              </span>
              {action && action !== "관망" && <span className={`sr-badge ${badgeClass(action)}`}>{action}</span>}
              <span className="sr-caret">{open ? "▴" : "▾"}</span>
            </button>

            {open && (<>
            {q?.time && <div className="hint" style={{ marginBottom: 8 }}>{staleness(q.time)}</div>}
            {/* 보유 중이면 "지금 뭘 해야 하나"를 세 갈래로 먼저 보여준다.
                매도 강도 숫자 하나만으로는 지키라는 건지 사라는 건지 알 수 없다. */}
            {held && (() => {
              const hv = holdVerdict(action);
              return (
                <div className="hv">
                  <div className="hv-seg">
                    {HOLD_CHOICES.map((c) => (
                      <span key={c} className={`hv-item${c === hv.choice ? ` on hv-${c === "팔기" ? "sell" : c === "더 사기" ? "buy" : "keep"}` : ""}`}>
                        {c}
                      </span>
                    ))}
                  </div>
                  <div className="hv-why">{hv.why}</div>
                  <div className="hv-pos">
                    {h!.qty}주 · 평단 {fmt(h!.avgPrice, currency)}
                    {sig?.pnlPct != null && (
                      <span className={pctClass(sig.pnlPct)}> · {sig.pnlPct >= 0 ? "+" : ""}{sig.pnlPct}%</span>
                    )}
                    {sig?.breakEvenPrice != null && ` · 본전 ${fmt(sig.breakEvenPrice, currency)}`}
                  </div>
                </div>
              );
            })()}
            {/* 0~10점 매수/매도 강도 — 가장 먼저 봐야 하는 숫자 */}
            {info && (() => {
              const kind: "buy" | "sell" = info.label.includes("매도") ? "sell" : "buy";
              const band = scoreBand(info.score, kind);
              // 엔진이 진입을 막은 상태면 구간 뜻풀이도 그에 맞춰야 한다.
              // "조건이 맞으면 검토할 만해요"는 틀린 말은 아니지만, 바로 위 요약이
              // "지금은 진입하지 않습니다"라고 말하는 상황에서는 허용적으로 읽힌다.
              const meaning = sig?.entryBlocked && kind === "buy" ? "지금은 사지 마세요 — 아래 이유를 확인하세요" : band.text;
              return (
                <div className="score-panel">
                  <div className="score-top">
                    <span className="score-label">{info.label}</span>
                    <span className={`score-band ${info.tone}`}>{band.name}</span>
                  </div>
                  {/* 0~10 눈금 — 숫자가 어디쯤인지 눈으로 보이게 한다 */}
                  <div className="score-scale">
                    <div className="score-scale-track">
                      {SCORE_BANDS.map((b, i) => (
                        <span key={b.name} className={`ss-seg${i <= band.idx ? ` on ${info.tone}` : ""}`} />
                      ))}
                      <span className={`ss-pin ${info.tone}`} style={{ left: `${(info.score / 10) * 100}%` }}>
                        {info.score}
                      </span>
                    </div>
                    <div className="score-scale-ticks">
                      <span>0 없음</span><span>5 보통</span><span>10 매우 강함</span>
                    </div>
                  </div>
                  <div className="score-mean">{meaning}</div>
                  <div className="score-action">{info.oneLiner}</div>
                  {/* AI와 엔진이 반대를 말할 때 두 문장을 나란히 두면 사용자는 어느 쪽을 따를지 모른다.
                      엔진이 진입을 막았는데 AI가 사라고 하면, 그 사실 자체를 먼저 알린다. */}
                  {sig?.entryBlocked && (action === "신규매수" || action === "추가매수") && (
                    <div className="score-conflict">
                      ⚠️ AI는 매수를 권하지만 계산 엔진은 <b>지금 진입을 막고 있습니다</b>.
                      아래 경고를 먼저 읽고, 확신이 없으면 사지 마세요.
                    </div>
                  )}
                  {sig?.verdict && <div className="score-sub">{sig.verdict}</div>}
                </div>
              );
            })()}

            {sig && (
              <>
                {(action === "신규매수" || action === "추가매수") && (ai?.entryPrice ?? sig.suggestedEntryPrice) != null && (
                  <div className="kv-row">
                    <span className="k">{held ? "추가 매수가 (피라미딩)" : "매수 진입가"}</span>
                    <span className="v">{fmt(ai?.entryPrice ?? sig.suggestedEntryPrice, currency)}</span>
                  </div>
                )}
                {(ai?.targetPrice ?? sig.targetPrice) != null && (
                  <div className="kv-row">
                    <span className="k">{held ? "목표가 (여기서 매도 고려)" : "매수 시 목표가"}</span>
                    <span className="v up">{fmt(ai?.targetPrice ?? sig.targetPrice, currency)}</span>
                  </div>
                )}
                {(ai?.stopPrice ?? sig.stopPrice) != null && (
                  <div className="kv-row">
                    <span className="k">손절가 (반드시 지키세요)</span>
                    <span className="v down">{fmt(ai?.stopPrice ?? sig.stopPrice, currency)}</span>
                  </div>
                )}
                {sig.suggestedQty != null && (action === "신규매수" || action === "추가매수") && (
                  <div className="kv-row">
                    <span className="k">{held ? "제안 추가매수 규모" : "제안 매수 규모"}</span>
                    <span className="v">약 {sig.suggestedQty}주 ({fmt(sig.suggestedBudget, currency)})</span>
                  </div>
                )}
                {held && sig.scaledExit.length > 0 && (
                  <div className="exit-plan-box">
                    <div className="exit-plan-title">📤 매도 계획 — 언제, 얼마나 팔까</div>
                    {sig.scaledExit.map((o, i) => (
                      <div className="exit-plan-item" key={i}>
                        <span className="exit-plan-price">{fmt(o.price, currency)}</span>
                        <span className="exit-plan-qty">{o.qty}주</span>
                        <span className="exit-plan-note">{o.note}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {ai && (
              <div className="reason-list">
                {ai.rationale.slice(0, 2).map((r, i) => (
                  <div className="reason" key={i}>{r}</div>
                ))}
              </div>
            )}
            {!ai && sig && (
              <div className="reason-list">
                {sig.reasons.slice(0, 2).map((r, i) => (
                  <div className="reason" key={i}>{r}</div>
                ))}
              </div>
            )}

            {sig?.volForecast && (
              <div className="vol-strip">
                <span className={`vol-badge vol-${sig.volForecast.regime}`}>변동성 {sig.volForecast.regime}</span>
                <span>
                  내일 예상 등락 {sig.volForecast.range90.lowPct.toFixed(1)}% ~ +{sig.volForecast.range90.highPct.toFixed(1)}%
                  {" · "}
                  {fmt(sig.price * (1 + sig.volForecast.range90.lowPct / 100), currency)} ~ {fmt(sig.price * (1 + sig.volForecast.range90.highPct / 100), currency)}
                </span>
              </div>
            )}

            {/* "오늘 오를 확률" — 사용자가 가장 먼저 묻는 질문에 대한 정직한 답.
                방향 예측 모델을 3번 만들어 3번 다 기저율을 못 넘었으므로 확률을 지어내지 않고
                "이 국면의 과거 실측 상승률 + 기저율과 구분되는가"를 그대로 보여준다. */}
            {sig?.upRate && (
              <div className={`uprate ${sig.upRate.distinguishable ? "sig" : ""}`}>
                <div className="uprate-top">
                  <span className="uprate-k">오늘 상승 확률</span>
                  <span className="uprate-v">{sig.upRate.upRatePct}%</span>
                  <span className="uprate-base">전체 평균 {sig.upRate.overallPct}%</span>
                </div>
                <div className="uprate-note">
                  {sig.upRate.distinguishable ? (
                    <>
                      <b>{sig.upRate.regime}</b> 국면 · 과거 {sig.upRate.sampleN}일 실측 — 평균과 구분되는 드문 경우입니다.
                    </>
                  ) : (
                    <>
                      <b>{sig.upRate.regime}</b> 국면 · 과거 {sig.upRate.sampleN}일 실측. 전체 평균과 <b>통계적으로 구분되지 않습니다</b> —
                      오늘 방향은 사실상 동전던지기입니다. 방향이 아니라 <b>얼마에·얼마나·어디서 자를지</b>로 판단하세요.
                    </>
                  )}
                </div>
              </div>
            )}

            {/* 위 변동성 한 줄을 그림으로 풀어준 것 — 조회 시점부터 마감, 그리고 내일·모레까지 */}
            {sig?.forecastPath && (
              <ForecastChart path={sig.forecastPath} currency={currency} stopPrice={sig.stopPrice} targetPrice={sig.targetPrice} action={action} />
            )}

            {sig && (
              <button className="detail-toggle-btn" onClick={() => toggleExpand(ticker)}>
                {isOpen ? "자세한 지표 숨기기 ▲" : "자세한 지표 보기 (VWAP·매매플랜·백테스트 등) ▼"}
              </button>
            )}

            {sig && isOpen && (
              <>
                <div className="kv-row" style={{ marginTop: 10 }}>
                  <span className="k">신호 점수 (엔진 0~100)</span>
                  <span className="v">{sig.score}점 (신뢰도 {ai?.confidence ?? sig.confidence})</span>
                </div>
                {sig.estimatedRoundTripCostWon != null && (
                  <div className="kv-row">
                    <span className="k">예상 거래비용 (세금+수수료)</span>
                    <span className="v" style={{ color: "var(--text-weak)" }}>약 {fmt(sig.estimatedRoundTripCostWon, currency)}</span>
                  </div>
                )}
                {/* 본전가 — "평단에 팔면 본전"이 아니다. 매도세 0.15%를 넘겨야 손해가 아니다 */}
                {sig.breakEvenPrice != null && (
                  <div className="kv-row">
                    <span className="k">본전 가격 (여기 넘겨야 이익)</span>
                    <span className="v">{fmt(sig.breakEvenPrice, currency)}</span>
                  </div>
                )}
                {/* 오늘 거래가 멈추는 지점 — 국내 단타에서 지정가를 걸 때 반드시 알아야 한다 */}
                {sig.priceLimits && (
                  <div className="vi-box">
                    <div className="vi-bar">
                      <span className="vi-t vi-down">하한 {fmt(sig.priceLimits.lowerLimit, currency)}</span>
                      <span className="vi-t">VI {fmt(sig.priceLimits.viLower, currency)}</span>
                      <span className="vi-t">VI {fmt(sig.priceLimits.viUpper, currency)}</span>
                      <span className="vi-t vi-up">상한 {fmt(sig.priceLimits.upperLimit, currency)}</span>
                    </div>
                    <div className="vi-note">{sig.priceLimits.note}</div>
                  </div>
                )}
                <div className="kv-row">
                  <span className="k">RSI / 20일선</span>
                  <span className="v">
                    {sig.indicators.rsi14.toFixed(0)} / {fmt(sig.indicators.ma20, currency)}
                  </span>
                </div>

                {sig.intraday?.available && (
                  <div className="intraday-box">
                    <div className="intraday-box-title">
                      📊 오늘의 장중 데이터
                      {!sig.intraday.isToday && <span className="stale-tag">최근 거래일 기준</span>}
                    </div>
                    <div className="intraday-grid">
                      <div className="intraday-cell">
                        <div className="ic-label">VWAP (당일 평균단가)</div>
                        <div className="ic-value">{fmt(sig.intraday.vwap, currency)}</div>
                        <div className={`ic-sub ${pctClass(sig.intraday.distanceFromVwapPct)}`}>
                          {sig.intraday.distanceFromVwapPct >= 0 ? "+" : ""}
                          {sig.intraday.distanceFromVwapPct.toFixed(2)}% {sig.intraday.distanceFromVwapPct >= 0 ? "위" : "아래"}
                        </div>
                      </div>
                      <div className="intraday-cell">
                        <div className="ic-label">시가 갭</div>
                        <div className="ic-value">{sig.intraday.gapType}</div>
                        <div className={`ic-sub ${pctClass(sig.intraday.gapPct)}`}>
                          {sig.intraday.gapPct >= 0 ? "+" : ""}
                          {sig.intraday.gapPct.toFixed(2)}%
                        </div>
                      </div>
                      <div className="intraday-cell">
                        <div className="ic-label">오프닝레인지(첫 30분)</div>
                        <div className="ic-value" style={{ fontSize: 13 }}>
                          {sig.intraday.orbStatus}
                        </div>
                        <div className="ic-sub">
                          {fmt(sig.intraday.openingRangeLow, currency)}~{fmt(sig.intraday.openingRangeHigh, currency)}
                        </div>
                      </div>
                      <div className="intraday-cell">
                        <div className="ic-label">당일 모멘텀</div>
                        <div className="ic-value" style={{ fontSize: 13 }}>
                          {momentumLabel(sig.intraday.momentum)}
                        </div>
                        <div className="ic-sub">당일 레인지 {sig.intraday.rangePositionPct.toFixed(0)}% 지점</div>
                      </div>
                    </div>
                  </div>
                )}
                {!sig.intraday?.available && (
                  <div className="reason warn" style={{ marginTop: 10 }}>
                    ⚠️ 장중 데이터 수집 실패 — 일봉 지표만으로 판단했습니다. 신뢰도가 낮으니 보수적으로 접근하세요.
                  </div>
                )}

                {((ai?.entryTriggers ?? sig.entryTriggers).length > 0 ||
                  sig.scaledEntry.length > 0 ||
                  (!held && sig.scaledExit.length > 0) ||
                  (ai?.invalidation ?? sig.invalidation)) && (
                  <div className="plan-box">
                    <div className="plan-title">🎯 오늘의 매매 플랜</div>
                    {(ai?.entryTriggers ?? sig.entryTriggers).length > 0 && (
                      <div className="plan-block">
                        <div className="plan-block-title">진입 조건 (이게 충족되면)</div>
                        {(ai?.entryTriggers ?? sig.entryTriggers).map((t, i) => (
                          <div className="plan-item" key={i}>▸ {t}</div>
                        ))}
                      </div>
                    )}
                    {sig.scaledEntry.length > 0 && (
                      <div className="plan-block">
                        <div className="plan-block-title">분할 매수 라인</div>
                        {sig.scaledEntry.map((o, i) => (
                          <div className="plan-item" key={i}>
                            ▸ {fmt(o.price, currency)} · {o.qty}주 — {o.note}
                          </div>
                        ))}
                      </div>
                    )}
                    {/* 보유 중인 경우의 매도 계획은 카드 상단에 항상 보이는 "📤 매도 계획" 블록에서 이미 보여준다 (여기선 중복 방지) */}
                    {!held && sig.scaledExit.length > 0 && (
                      <div className="plan-block">
                        <div className="plan-block-title">분할 매도(익절) 라인 — 신규 매수 시 참고</div>
                        {sig.scaledExit.map((o, i) => (
                          <div className="plan-item" key={i}>
                            ▸ {fmt(o.price, currency)} · {o.qty}주 — {o.note}
                          </div>
                        ))}
                      </div>
                    )}
                    {(ai?.invalidation ?? sig.invalidation) && (
                      <div className="plan-block plan-invalidation">
                        <div className="plan-block-title">⛔ 무효화 조건 (목표가·손절가와 무관하게 즉시 재검토)</div>
                        <div className="plan-item">{ai?.invalidation ?? sig.invalidation}</div>
                      </div>
                    )}
                    {/* 확인 시간이 불규칙한 사용자를 위한 예약주문 안내 — 조건부(하루 이상 못 볼 때)로만 권한다 */}
                    {sig.watchOrderNote && (
                      <div className="plan-block plan-watch">
                        <div className="plan-block-title">🔔 자리 비울 때 (증권사 예약·감시주문)</div>
                        <div className="plan-item">{sig.watchOrderNote}</div>
                      </div>
                    )}
                  </div>
                )}

                {sig.backtest && sig.backtest.sampleSignals > 0 && (
                  <div className="kv-row" style={{ marginTop: 8 }}>
                    <span className="k">과거 유사신호 통계 (참고용)</span>
                    <span className="v" style={{ fontSize: 13, textAlign: "right" }}>
                      5일 승률 {sig.backtest.winRate5d}% · 평균 {sig.backtest.avgReturn5d}% ({sig.backtest.sampleSignals}회 표본)
                    </span>
                  </div>
                )}

                {ai && (
                  <div className="reason-list">
                    <div className="reason" style={{ background: "var(--blue-weak)", color: "#1b64da", fontWeight: 700 }}>
                      💡 {ai.headline}
                      {ai.timeHorizon && <span className="time-horizon-tag">{ai.timeHorizon}</span>}
                    </div>
                    {ai.rationale.map((r, i) => (
                      <div className="reason" key={i}>{r}</div>
                    ))}
                    {ai.checklist.length > 0 && (
                      <div className="reason warn">
                        ✅ 실행 전 체크: {ai.checklist.join(" · ")}
                      </div>
                    )}
                  </div>
                )}
                {!ai && (
                  <div className="reason-list">
                    {sig.entryPriceBasis && (
                      <div className="reason">📍 {held ? "추가 매수가 근거" : "매수 진입가 근거"}: {sig.entryPriceBasis}</div>
                    )}
                    {sig.reasons.slice(0, 4).map((r, i) => (
                      <div className="reason" key={i}>{r}</div>
                    ))}
                    {sig.warnings.slice(0, 3).map((w, i) => (
                      <div className="reason warn" key={i}>⚠️ {w}</div>
                    ))}
                  </div>
                )}
              </>
            )}

            {!sig && !loading && (
              <div className="hint">위의 &quot;AI 정밀 분석&quot; 버튼을 누르면 매수/매도 타이밍 조언이 표시됩니다.</div>
            )}
            </>)}
          </div>
          </Fragment>
        );
      })}

      </div>{/* ===== /탭: 종목 2구간 ===== */}

      {/* ===== 탭: 분석 방식 — 어떤 변수를 어떻게 쓰는지 전부 공개 ===== */}
      <div style={{ display: tab === "분석방식" ? undefined : "none" }}>
        <div className="doc-intro">
          이 앱이 <strong>무엇을 보고</strong>, <strong>어떻게 판단하며</strong>, <strong>어디까지 믿을 수 있는지</strong>를
          전부 공개합니다. 숫자는 모두 5개년 실데이터로 검증한 값이며, 검증 스크립트로 언제든 재현할 수 있습니다.
        </div>

        {/* 조각조각 설명하기 전에, 전체가 어떻게 이어지는지부터 보여준다.
            수백 번 고친 끝에 남은 최종 구조라 여기서부터 읽는 것이 맞다. */}
        <div className="doc-sec doc-pipe-sec">
          <div className="doc-h">⓪ 전체 흐름 한눈에 (최종 정리)</div>
          <div className="doc-pipe-lead">
            수집한 수천 개의 값이 <b>화면의 &quot;오늘 나의 행동&quot; 한 줄</b>이 되기까지 6단계를 거칩니다.
            각 단계는 앞 단계의 결과만 받고, 검증되지 않은 값은 다음 단계로 넘기지 않습니다.
          </div>
          {[
            {
              n: "1",
              t: "모은다",
              d: "시세·분봉·5년 일봉 / SOX·환율·유가·VIX·금리·선물·코스피 / 외국인·기관·연기금·신용잔고 / DART 공시 / 뉴스 최대 60건",
              k: "종목 10개(반도체 5 + 비반도체 5) × 15분 주기 자동 수집",
            },
            {
              n: "2",
              t: "정리한다",
              d: "가격은 지표로(RSI·MACD·볼린저·ADX·VWAP…), 수급은 20일 평균거래량 대비 비율로, 뉴스는 7개 축(업황·지정학·중국·실적·큰손·매크로·지수)별 건수와 압력으로 집계",
              k: "원문 60건을 축별 집계 + 대표 12건으로 압축 — 정보는 늘리고 토큰은 줄인다",
            },
            {
              n: "3",
              t: "폭을 잰다",
              d: "오늘·내일 얼마나 움직일지를 EWMA 변동성 + 실제 분포(꼬리 두꺼움)로 계산. 여기서 나온 σ가 이후 모든 숫자의 뿌리",
              k: "검증됨 — 90% 구간 실제 적중 88.1%",
            },
            {
              n: "4",
              t: "장세를 가른다",
              d: "폭락장 / 급등과열 / 변동성확대 / 보통을 엔진이 스스로 분류하고, 같은 국면이었던 과거 시점만 골라 그때 실제로 무슨 일이 있었는지를 본다",
              k: "사람이 모드를 고르지 않는다 — 데이터가 정한다",
            },
            {
              n: "5",
              t: "행동을 만든다",
              d: "국면에서 통계적 우위가 검증된 행동만 남긴다. 지정가는 σ 비례 + 호가단위로 반올림, 수량은 리스크 1% 규칙, 손절은 σ 배수, 상관 0.7↑ 종목쌍은 합산 50% 제한",
              k: "우위가 없으면 「오늘은 없음」이 정답",
            },
            {
              n: "6",
              t: "AI가 검토한다",
              d: "엔진이 만든 숫자·뉴스 집계·공시를 Claude에 넘겨, 룰이 놓친 정성 요인(트럼프 발언·중국 증설·큰손 포지션)을 반영해 문장으로 정리. 단 AI는 가격을 새로 만들지 못하고, 만들어도 코드가 호가단위로 되돌린다",
              k: "AI는 해석자이지 계산기가 아니다",
            },
          ].map((s) => (
            <div className="doc-pipe" key={s.n}>
              <span className="doc-num">{s.n}</span>
              <div>
                <div className="doc-pipe-t">{s.t}</div>
                <div className="doc-pipe-d">{s.d}</div>
                <div className="doc-chk">{s.k}</div>
              </div>
            </div>
          ))}
          <div className="doc-pipe-lead" style={{ marginTop: 12 }}>
            <b>이 구조에서 일부러 빠진 것</b>: &quot;내일 오른다/내린다&quot;는 방향 예측. 세 번 만들어 세 번 실패했고
            그 기록을 ④에 남겨뒀습니다. 대신 <b>얼마에·얼마나·어디서 자를지</b>에 집중합니다.
          </div>
        </div>

        <details className="doc-sec">
          <summary className="doc-h">① 무엇을 보고 판단하나 — 입력 변수</summary>
          {[
            { g: "가격·차트", items: [
              ["일봉 5년치", "추세선(20·60일), RSI, MACD, 볼린저, 스토캐스틱, 피벗, ADX, 다이버전스, 해머캔들, OBV"],
              ["장중 분봉", "VWAP(거래량가중평균가), 갭, 개장 30분 고저 돌파, 최근 30분 모멘텀"],
              ["거래량", "20일 평균 대비 증감, Z점수 — 움직임에 실체가 있는지 확인"],
            ]},
            { g: "해외·매크로", items: [
              ["미 반도체지수(SOX)", "★가장 중요. 전일 미국장 SOX와 국내 반도체주의 상관이 같은 날짜보다 2배 강함(0.33~0.43 vs 0.18~0.22). 밤사이 갭으로 거의 그대로 전이됨"],
              ["원/달러 환율", "급등 시 외국인 이탈 압력"],
              ["국제유가(WTI)", "급등이든 급락이든 방향과 무관하게 매크로 리스크 확대 신호"],
              ["VIX·공포탐욕지수", "시장 전체 공포 수준 — 포지션 축소 판단"],
              ["미 10년물 국채금리", "기술주 밸류에이션(할인율) 리스크. ※점수에는 반영하지 않고 맥락으로만 씁니다 — 자체 데이터가 아직 없어 기여도를 실측하지 못했고, 검증 안 된 변수는 점수에 넣지 않는 것이 이 엔진의 원칙입니다"],
              ["나스닥·S&P500 선물", "장 시작 전 방향성 참고"],
              ["코스피", "국내장 전반 리스크"],
            ]},
            { g: "수급·공시", items: [
              ["외국인·기관 순매수", "KRX 공식 데이터, 전일 확정치. 20일 평균거래량 대비 비율로 정규화"],
              ["연기금 순매수", "3일 연속 순매수면 장기 자금이 하방을 받치는 신호(+2점)"],
              ["신용융자 잔고", "빚투가 20일새 15%+ 급증하면 감점 — 급락 시 반대매매가 하락을 증폭"],
              ["DART 전자공시", "실적·자사주·유상증자 등. 뉴스보다 빠르고 공식적이라 1차 근거로 우선"],
            ]},
            { g: "뉴스·이벤트", items: [
              ["실시간 뉴스·속보 (최대 60건)", "12시간 이내 기사만. 종목 뉴스는 20건으로 제한하고 나머지는 지수·업황·지정학·중국·큰손·실적·매크로에 배분 — 뉴스가 몇 건뿐이면 그 몇 건으로 오판하기 때문에 수집량을 3배로 늘렸습니다(③번 항목 참조)"],
              ["반도체 사이클 뉴스", "D램/낸드 현물가 반등 여부(삼성전자·하이닉스 바닥 신호), 빅테크 AI 설비투자(CAPEX) 가이던스 상·하향 — 정형 데이터로 살 수 있는 API가 없어 뉴스로 수집합니다"],
              ["과거 이벤트 타임라인", "2023~2026 반도체·매크로 주요 사건과 그때의 교훈"],
            ]},
          ].map((blk) => (
            <div className="doc-grp" key={blk.g}>
              <div className="doc-grp-t">{blk.g}</div>
              {blk.items.map(([k, v]) => (
                <div className="doc-row" key={k as string}>
                  <div className="doc-k">{k}</div>
                  <div className="doc-v">{v}</div>
                </div>
              ))}
            </div>
          ))}
        </details>

        <details className="doc-sec">
          <summary className="doc-h">② 어떻게 예측하나 — 단계별</summary>
          <div className="doc-step"><span className="doc-num">1</span><div>
            <strong>변동성 추정</strong> — 내일 얼마나 움직일지를 확률 구간으로 계산합니다.
            최근 변동에 가중치를 크게 두는 방식(EWMA)에 전일 SOX 급변동과 거래량 급증을 반영하고,
            정규분포 대신 이 종목의 실제 분포(꼬리가 두꺼움)를 씁니다.
            <div className="doc-chk">검증: 90% 구간 적중률 88.1%, 98% 구간 97.4% (목표 90/98)</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">2</span><div>
            <strong>장세 판별</strong> — 오늘이 어떤 장인지 엔진이 스스로 분류합니다.
            폭락장(SOX -3.5%↓ / 코스피 -3%↓ / 종목 -7%↓) · 급등과열(+12%↑) · 변동성확대 · 보통.
            <div className="doc-chk">모드를 사람이 고르지 않고 데이터가 정합니다</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">3</span><div>
            <strong>국면별 조건부 통계</strong> — &quot;지금과 같은 상태였던 과거 시점&quot;만 골라 그 다음 20거래일에
            실제로 무슨 일이 있었는지 분포로 봅니다. 여러 장세를 뭉갠 평균은 쓰지 않습니다.
            <div className="doc-chk">상승 국면 손실확률 37~42% vs 조정·붕괴 국면 52~56%로 뚜렷이 갈림</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">4</span><div>
            <strong>장세별 작전</strong> — 그 국면에서 통계적 우위가 검증된 행동만 제안합니다.
            폭락장이면 소액 반등 노림수 + 패닉 매도 방지, 급등과열이면 다음날 지정가 분할 익절,
            평상시면 변동성 비례 눌림목 지정가.
            <div className="doc-chk">우위가 없는 날은 &quot;오늘은 없음&quot;이 정답입니다</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">5</span><div>
            <strong>예상 경로 차트</strong> — 위 ①의 변동성을 &quot;조회 시점 → 오늘 마감 → 다음 거래일 → 2거래일 뒤&quot;
            그림으로 펼친 것입니다. 불확실성은 시간에 비례해 쌓이므로 폭은 √시간으로 벌어지고,
            하루 안에서는 개장 직후·마감 무렵이 크고 점심때가 작은 U자 배분을 씁니다.
            중앙선은 예측이 아니라 &quot;제자리 + 과거 같은 국면의 아주 약한 평균 흐름(하루 ±0.5% 제한)&quot;입니다.
            <div className="doc-chk">검증: 다음 거래일 90% 구간 적중 88.3% / 2거래일 89.4% / 3거래일 88.6% (표본 각 1,235회)</div>
            <div className="doc-chk">안쪽 50% 띠는 실제 적중 44.8~48.0% — 표시보다 살짝 좁게 잡힙니다(하루 기준 분위수를 여러 날에 그대로 써서 생기는 오차)</div>
            <div className="doc-chk">√시간 가정 실측 비율 0.87~1.04 (1.0이면 가정 정확)</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">6</span><div>
            <strong>위험 한도</strong> — 상관이 0.7 이상인 종목 쌍은 &quot;사실상 한 종목&quot;으로 보고
            합산 비중을 총자산의 50%로 제한합니다. 종목당 50%만 보던 기존 규칙으로는
            삼성전자 50% + SK하이닉스 50% = 100%가 &quot;분산&quot;으로 통과됐습니다.
            <div className="doc-chk">실측 상관: 5년 0.72 → 최근 1년 0.84 → 최근 6개월 0.89 (급변동장일수록 더 붙는다)</div>
            <div className="doc-chk">주의: 이 한도는 수익을 늘리지 않습니다. 위험대비수익은 한도를 바꿔도 거의 그대로였고(6개월 기준 1.57~1.71), 오직 최악의 날을 줄입니다 — 2천만원 기준 -280만원 → -140만원</div>
          </div></div>
        </details>

        {/* 뉴스는 "읽을 거리"가 아니라 "집계 가능한 신호"다 — 이 구분이 이번 개편의 핵심 */}
        <details className="doc-sec">
          <summary className="doc-h">③ 뉴스는 어떻게 숫자가 되나</summary>
          <div className="doc-pipe-lead">
            예전에는 뉴스 20건을 모아 10건만 AI에 넘겼습니다. 토큰을 아끼려던 선택이었는데,
            <b> 몇 건 안 되는 뉴스로 시장 전체를 판단하는 것이 더 큰 위험</b>이었습니다.
            그래서 <b>수집</b>과 <b>전송</b>을 분리했습니다.
          </div>
          <div className="doc-step"><span className="doc-num">1</span><div>
            <strong>수집 — 최대 60건</strong> (예전 20건). 종목 뉴스는 20건으로 제한하고 나머지 자리를
            지수·업황·지정학·중국 반도체·큰손 동향·실적 전망·매크로에 배분합니다. 12시간 이내 기사만 받습니다.
            <div className="doc-chk">수집은 Gemini 몫이라 AI(Claude) 비용과 무관하고, 아래 2단계에서 크기가 고정되도록 압축됩니다</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">2</span><div>
            <strong>집계 — 7개 축으로 나눠 센다.</strong> 기사마다 영향도(높음 3 / 중간 2 / 낮음 1)에
            부호(호재 +, 악재 −)를 붙여 축별로 더한 뒤 건수로 나눕니다. 이 값이 <b>압력</b>입니다.
            <table className="doc-tbl" style={{ marginTop: 6 }}><tbody>
              <tr><th>업황</th><td>D램·낸드·HBM·현물가·가동률 → 국내 반도체 전반</td></tr>
              <tr><th>지정학</th><td>관세·수출규제·전쟁·중동·미중 → 지수 전체 하방 압력</td></tr>
              <tr><th>중국</th><td>SMIC·YMTC·CXMT 증설 → 판가 경쟁, 메모리 마진 직격</td></tr>
              <tr><th>실적</th><td>TSMC·마이크론·ASML 가이던스 → 개별 종목 재평가</td></tr>
              <tr><th>큰손</th><td>버핏·마이클 버리·13F·공매도·연기금 → 수급 심리</td></tr>
              <tr><th>매크로</th><td>금리·환율·유가·CPI·연준 → 할인율·밸류에이션</td></tr>
              <tr><th>지수</th><td>코스피·나스닥·SOX·선물·VIX → 시장 전체 방향</td></tr>
            </tbody></table>
            <div className="doc-chk">같은 &quot;악재&quot;라도 축이 다르면 맞는 종목이 다릅니다. 지정학은 10종목 전부를, 중국 증설은 메모리 2종목만 때립니다</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">3</span><div>
            <strong>전송 — 집계 전체 + 원문 12건.</strong> AI에는 (ⓐ) 전체 집계 한 줄, (ⓑ) 축별 건수·압력,
            (ⓒ) 원문 12건을 함께 보냅니다. 12건은 앞에서 자르지 않고 <b>각 축에서 최소 1건씩 확보한 뒤</b>
            남는 자리를 속보·고영향 순으로 채웁니다.
            <div className="doc-chk">앞에서 N건만 자르면 지정학 뉴스가 통째로 빠지는 날이 생깁니다 — 축별 대표 확보가 그걸 막습니다</div>
            <div className="doc-chk">
              실측 토큰: 수집이 <b>60건이든 100건이든 930 vs 938토큰</b>으로 사실상 같습니다(집계는 크기가 고정, 원문은 12건 상한).
              60건을 전부 원문으로 보냈다면 3,716토큰 — <b>4배</b>였습니다.
            </div>
            <div className="doc-chk">
              정직하게 — 예전 방식(수집 20 / 원문 10건 = 667토큰)보다는 <b>263토큰 늘었습니다</b>.
              축별 집계 138토큰 + 원문 2건 추가분입니다. 수집을 3배로 넓히고 7개 축 누락을 없애는 값으로는
              싸다고 판단했습니다(10종목 전체 페이로드 5,795토큰의 15%).
            </div>
            <div className="doc-chk">
              축이 &quot;무엇을 때리는지&quot;(고정 문구)는 매번 보내지 않고 1시간 캐시되는 시스템 프롬프트에 넣었습니다 — 재사용 시 비용 1/10.
            </div>
          </div></div>
          <div className="doc-step"><span className="doc-num">4</span><div>
            <strong>표본이 적으면 그렇다고 말한다.</strong> 수집이 12건 미만이면 집계에
            &quot;표본이 적어 오판 위험&quot; 표시가 붙고, AI는 뉴스 근거의 비중을 낮추고 기술적·수급 근거를 앞세우도록 지시받습니다.
            화면에도 같은 경고가 그대로 뜹니다.
          </div></div>
          <div className="doc-sec doc-warn" style={{ margin: "12px 0 0", padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 4, fontSize: "calc(13px * var(--font-scale))" }}>정직한 한계</div>
            <div style={{ fontSize: "calc(12.5px * var(--font-scale))", lineHeight: 1.55 }}>
              이 집계는 <b>&quot;지금 무슨 일이 벌어지고 있나&quot;의 요약이지 &quot;그래서 몇 % 오른다&quot;의 예측이 아닙니다.</b>
              뉴스 유형과 다음날 등락을 연결하려면 과거 뉴스를 전부 라벨링한 데이터가 필요한데 그런 자료가 없습니다.
              그래서 이 압력 값으로 <b>새 점수를 만들지 않습니다</b>. 사람과 AI가 판단에 참고하도록 그대로 보여줄 뿐입니다.
            </div>
          </div>
        </details>

        {/* 분석이 맞아도 실행이 틀리면 돈을 잃는다. 이 절은 "분석" 아닌 "실행"에 관한 규칙이다. */}
        <details className="doc-sec">
          <summary className="doc-h">④ 계좌를 지키는 규칙 (실행)</summary>
          <div className="doc-pipe-lead">
            분석이 정확해도 실행이 틀리면 돈을 잃습니다. 여기 있는 것들은 &quot;무엇을 살까&quot;가 아니라
            <b> &quot;어떻게 살아남을까&quot;</b>에 관한 규칙입니다.
          </div>
          <div className="doc-step"><span className="doc-num">1</span><div>
            <strong>하루 손실 한도 −3%</strong> — 오늘 계좌가 총자산의 3%를 잃으면 그날은 신규 매수를 멈춥니다.
            매도·손절 판단은 그대로 둡니다(멈춰야 하는 건 사는 것이지 빠져나오는 게 아닙니다).
            <div className="doc-chk">왜 필요한가: 종목별 &quot;1회 리스크 1%&quot; 규칙만으로는 여러 종목이 같은 날 무너지는 상황을 못 막습니다 — 반도체 5종목 상관이 0.89라 사실상 한 종목입니다</div>
            <div className="doc-chk">검증(1,229거래일): 누적수익 +632% → +622%(거의 그대로), 최대낙폭 −52.0% → <b>−42.8%</b>, 샤프 1.16 → 1.25</div>
            <div className="doc-chk">견고성: 기간을 4등분해도 3개 구간에서 낙폭이 줄었고, <b>가장 크게 무너진 두 구간에서 개선폭이 가장 컸습니다</b>(+10.5%p, +13.9%p)</div>
            <div className="doc-chk">−4%·−5%·−7%는 오히려 나빴습니다 — 한도를 느슨하게 잡으면 아무것도 막지 못합니다</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">2</span><div>
            <strong>오늘 거래가 멈추는 지점</strong> — 종목마다 상한가·하한가(전일 종가 ±30%)와
            정적VI 발동가(±10%)를 표시합니다. VI에 닿으면 약 2분간 단일가매매로 바뀌어 호가창이 멈춥니다.
            <div className="doc-chk">지정가를 VI 너머에 걸어두면 즉시 체결을 기대할 수 없습니다. 상·하한가 밖은 아예 체결되지 않습니다</div>
            <div className="doc-chk">한계: 동적VI(직전 체결가 대비 급변 시 발동)는 기준이 실시간 체결가라 15~20분 지연되는 무료 시세로는 계산할 수 없어 뺐습니다. 배당락·거래정지 해제일에는 거래소가 별도 기준가를 정하므로 그런 날은 증권사 화면을 우선하세요</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">3</span><div>
            <strong>본전 가격</strong> — &quot;평단에 팔면 본전&quot;이 아닙니다. 국내 주식은 <b>팔 때만</b> 세금을 냅니다.
            <table className="doc-tbl" style={{ marginTop: 6 }}><tbody>
              <tr><th>매도 시 세금</th><td>0.15% (2025년 이후 코스피·코스닥 공통)</td></tr>
              <tr><th>위탁수수료</th><td>0.015% × 2 (매수·매도 각각, 증권사별 편차 있음)</td></tr>
              <tr><th>왕복 합계</th><td><b>약 0.18%</b> — 여기를 넘겨야 비로소 손해가 아닙니다</td></tr>
            </tbody></table>
            <div className="doc-chk">목표가가 본전가보다 낮으면 이기고도 손해입니다 — 그런 매매는 제안하지 않습니다</div>
          </div></div>
          <div className="doc-step"><span className="doc-num">4</span><div>
            <strong>추천 성적표</strong> — 이 앱의 추천이 실제로 맞았는지 기록하고 채점합니다.
            방향을 주장한 추천(매수·매도)만 세고, 5거래일이 지나면 판정을 확정합니다.
            <div className="doc-chk">기록은 이 기기 안에만 저장됩니다(매매 내역은 서버로 보내지 않습니다)</div>
            <div className="doc-chk">이건 &quot;내 수익률&quot;이 아니라 &quot;앱 추천의 성적표&quot;입니다 — 실제로 그대로 매매했는지는 앱이 모르고, 장중 고저가를 몰라 손절선을 스쳤다 되돌아온 경우가 빠져 <b>실제보다 좋게 나옵니다</b></div>
          </div></div>
          <div className="doc-sec doc-warn" style={{ margin: "12px 0 0", padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 4, fontSize: "calc(13px * var(--font-scale))" }}>솔직히 — 하루 손실 한도가 못 하는 것</div>
            <div style={{ fontSize: "calc(12.5px * var(--font-scale))", lineHeight: 1.55 }}>
              이 규칙은 <b>이미 발생한 오늘의 손실은 막지 못합니다</b>(손실이 난 뒤에 발동하므로).
              막는 것은 그 뒤에 이어지는 추격 매매·물타기입니다. 실제로 5년 실측에서
              −3% 이하로 마감한 86일의 <b>다음날 승률은 50%, 최악은 −11.9%</b>였습니다 —
              &quot;많이 빠졌으니 반등한다&quot;는 근거가 없다는 뜻입니다.
              그리고 강세장에서는 수익을 깎습니다(2025~2026 구간 +427% → +343%). 위험 관리의 값입니다.
            </div>
          </div>
        </details>

        <details className="doc-sec">
          <summary className="doc-h">⑤ 변수는 서로 어떻게 얽혀 있나 (상관관계와 반영 경로)</summary>
          <div className="doc-flow">
            {[
              {
                src: "간밤 미국 SOX 지수",
                rel: "국내 반도체주와 상관 0.33~0.43 (같은 날짜 SOX보다 2배 강함)",
                into: "① 변동성 추정에서 예상 등락폭을 넓히고 → ② 장세 판별(폭락장/급등과열) 기준이 되며 → ③ 매크로 점수로 개별 종목 점수에 직접 가산·감산",
              },
              {
                src: "뉴스 (최대 60건 수집 → 7개 축 집계)",
                rel: "축마다 때리는 대상이 다름 — 지정학·지수는 10종목 전부, 중국·업황은 메모리 2종목, 실적은 해당 종목만. 고임팩트 악재는 기술적 매수 신호를 무효화",
                into: "① 뉴스 감성 점수로 종목 점수에 반영 → ② 과열 교차검증(기술적 매수 신호라도 악재가 있으면 진입 보류) → ③ 축별 압력과 원문 12건을 AI에 함께 전달해 구조적 리스크로 인용 (자세히는 ③번 항목)",
              },
              {
                src: "DART 공시 · 밸류체인 관련사 공시",
                rel: "뉴스보다 빠르고 법적 의무 정보라 신뢰도 우선. 장비주 수주 공시는 대장주 설비투자를 선행",
                into: "같은 사안이면 뉴스 대신 공시를 1차 근거로 사용. 관련사 수주·증설 공시는 업황 방향 참고로만(점수 미반영)",
              },
              {
                src: "변동성(σ)",
                rel: "거의 모든 출력의 뿌리. 손절폭·목표가·매수 수량·예상 경로 폭·지정가 거리가 전부 σ에 비례",
                into: "σ가 커지면 → 손절폭이 넓어지고 → 리스크 1% 규칙에 따라 매수 수량이 자동으로 줄어든다 (고정 %가 아니라 σ 비례라 장세에 자동 적응)",
              },
              {
                src: "종목 간 상관 (삼성전자·하이닉스 0.89)",
                rel: "높을수록 분산 효과가 사라짐. 급변동장일수록 더 높아짐(5년 0.72 → 6개월 0.89)",
                into: "포트폴리오 위험을 상관행렬로 합산 → 합산 비중 50% 한도로 매수 수량 제한",
              },
              {
                src: "외국인·기관·연기금 수급",
                rel: "20일 평균거래량 대비 비율로 정규화(절대 주수는 종목마다 규모가 달라 비교 불가)",
                into: "수급 점수로 종목 점수에 가산·감산. 연기금 3일 연속 순매수는 별도 +2점",
              },
            ].map((f) => (
              <div className="doc-flow-item" key={f.src}>
                <div className="doc-flow-src">{f.src}</div>
                <div className="doc-flow-rel">↳ 관계: {f.rel}</div>
                <div className="doc-flow-into">↳ 반영: {f.into}</div>
              </div>
            ))}
          </div>
          <div className="doc-chk" style={{ marginTop: 8 }}>
            변수는 독립적으로 더해지지 않습니다. σ가 커지면 손절·수량·경로폭이 <b>동시에</b> 바뀌고, 상관이 높아지면 개별 종목 판단이 맞아도 포트폴리오 위험은 커집니다.
          </div>
        </details>

        <details className="doc-sec doc-warn">
          <summary className="doc-h">⑥ 우리가 시도했다가 버린 것 (실패 기록)</summary>
          <div className="doc-fail">
            <div className="doc-fail-t">방향 예측 — 세 번 만들고 세 번 실패했습니다</div>
            <div style={{ marginBottom: 10 }}>
              &quot;오늘 오를 확률이 몇 %인가&quot;에 답하려고 서로 다른 방식으로 세 번 모델을 만들었습니다.
              <table className="doc-tbl" style={{ marginTop: 6 }}><tbody>
                <tr><th>① 유사패턴 kNN (단일 시간대)</th><td>적중률 {analogStats.accuracyPct}% — 기준선 {analogStats.baselineMajorityPct}%에 미달</td></tr>
                <tr><th>② 다중 시간대 로지스틱</th><td>3일·1주·2주·1개월·6개월·3년 수익률 + 변동성 국면 + 낙폭 + 이격 + RSI + 거래량 + 간밤 SOX + 전일 코스피 <b>13개 특징, 표본 {probStats.sample.toLocaleString()}개</b> → Brier {probStats.models["로지스틱(다중 시간대)"].brier} (기저율과 <b>완전히 동일</b>), AUC {probStats.models["로지스틱(다중 시간대)"].auc} = 정보량 0</td></tr>
                <tr><th>③ 국면 조건부 (21개 국면)</th><td>다중검정 보정 후 기저율과 유의미하게 다른 국면 <b>{probStats.significantRegimes}개</b></td></tr>
              </tbody></table>
              <div style={{ marginTop: 8, fontWeight: 800 }}>&quot;표본과 조합을 늘리면 되지 않나?&quot; — 이것도 측정했습니다</div>
              <table className="doc-tbl" style={{ marginTop: 4 }}><tbody>
                <tr><th>검정력</th><td>지금 표본으로 탐지 가능한 최소 우위는 적중률 <b>{(50 + (powerStats.powerAnalysis[0].minDetectableAuc - 0.5) * 80).toFixed(1)}%</b>. 표본을 <b>10배</b>로 늘려도 <b>{(50 + (powerStats.powerAnalysis[2].minDetectableAuc - 0.5) * 80).toFixed(1)}%</b>까지만 내려갑니다 — 게다가 그 정도 우위는 왕복 거래비용(0.25%)에도 못 미칩니다</td></tr>
                <tr><th>조합 확대 실험</th><td>국면을 27 → 213 → 923 → 2,602개로 늘렸더니 <b>검증 적중률이 계속 떨어졌습니다</b> ({powerStats.comboResults.map((c: {testAcc:number}) => `${c.testAcc}%`).join(" → ")}). 셀당 표본이 194개 → 2개로 붕괴하기 때문입니다</td></tr>
                <tr><th>종목·시계 확대</th><td>종목 9개 × 예측시계 5종으로 넓혀도 1·2·3·5일 전부 신뢰구간이 0.5를 포함(신호 없음). 10일 후에서만 AUC {powerStats.horizonResults[4].auc}로 약한 신호가 있었으나 <b>단타 시계가 아니고</b> 추가 검증이 필요합니다</td></tr>
              </tbody></table>
              <div className="doc-chk" style={{ marginTop: 6 }}>
                조합을 늘리면 <b>학습 성적만 오르고 검증 성적은 떨어집니다</b>(과적합). 변수를 더 넣는 것이 답이 아니라는 뜻입니다.
              </div>
              <div className="doc-chk">
                <b>트럼프 발언·중동 정세·중국 반도체 증설·마이클 버리 등 큰손 포지션·CAPEX 가이던스·실적 전망</b>은
                과거 라벨이 없어 정량 모델에 넣을 수 없습니다. 대신 실시간 뉴스로 수집해 AI 판단 단계에 직접 투입하며,
                AI는 &quot;이 요인이 룰 엔진 점수에 빠져 있다&quot;는 사실과 함께 자신의 해석을 밝히도록 되어 있습니다.
              </div>
              <div className="doc-chk" style={{ marginTop: 6 }}>
                모델이 단조로워서가 아닙니다. 시간대를 3일부터 3년까지 늘리고 인과 요인(SOX·코스피·거래량)을 넣어도
                정보량이 늘지 않았습니다. <b>다음날 방향은 이 종목군에서 예측되지 않습니다.</b>
              </div>
              <div className="doc-chk">
                그래서 앱은 &quot;오를 것 같다&quot;를 말하지 않고, 국면별 <b>과거 실측 상승률</b>과
                &quot;전체 평균과 구분되는가&quot;를 그대로 보여줍니다. 대신 실제로 검증된 세 가지에 집중합니다 —
                <b>얼마에</b>(지정가+체결확률), <b>얼마나</b>(리스크 1% 수량), <b>어디서 자를지</b>(손절선).
              </div>
            </div>
          </div>
          <div className="doc-fail" style={{ display: "none" }}>
            <div className="doc-fail-t">방향 예측 (구버전 기록)</div>
            <div>
              지금 상태를 10개 변수로 벡터화해 과거 {analogStats.poolSize.toLocaleString()}개 패턴 중 가장 닮은 120건을 찾고, 그 다음날 결과로 방향을 예측하는 모델을 만들어 검증했습니다.
              결과는 <b>적중률 {analogStats.accuracyPct}%</b>로 기준선({analogStats.baselineMajorityPct}%)에 못 미쳤고,
              확신도가 높을수록 오히려 더 틀렸으며(확신 {analogStats.byConfidence[2]?.minConf}~{analogStats.byConfidence[2]?.maxConf}% 구간 적중률 {analogStats.byConfidence[2]?.accuracyPct}%),
              그대로 따라갔다면 <b>건당 평균 {analogStats.byConfidence[1]?.avgSignedRetPct}%</b>씩 잃었습니다.
              80% 구간의 실제 적중률도 {analogStats.band80CoveragePct}%에 그쳤습니다(목표 80%).
              이웃 수·인접일 제외·평가기간을 바꿔 5가지로 재검증해도 결론은 같았습니다.
              <div className="doc-chk">그래서 이 앱은 &quot;오를 것&quot; &quot;내릴 것&quot;을 말하지 않습니다. 대신 <b>도달 확률</b>(지정가에 닿을 가능성)을 제시합니다 — 이건 방향이 아니라 변동폭의 문제라 실제로 맞습니다.</div>
            </div>
          </div>
          <div className="doc-fail">
            <div className="doc-fail-t">고정 % 손절·익절 (-2% / +3%)</div>
            <div>학습구간 +36% → 검증구간 -5.5%로 뒤집혔습니다(과적합). σ 비례 방식만 네 구간을 모두 견뎠습니다.</div>
          </div>
          <div className="doc-fail">
            <div className="doc-fail-t">VIX를 변동성 모델에 넣기</div>
            <div>이론상 선행지표지만 실측 기여도가 0이라 제외했습니다. 미 10년물 국채금리도 같은 이유로 점수에는 넣지 않고 맥락으로만 씁니다.</div>
          </div>
        </details>

        <details className="doc-sec">
          <summary className="doc-h">⑦ 검증된 숫자</summary>
          <table className="doc-tbl"><tbody>
            <tr><th>폭락(-7%↓) 다음날</th><td>평균 +0.75% · 승률 58% (표본 127회, 거래비용 차감)</td></tr>
            <tr><th>급등(+12%↑) 다음날</th><td>고가 평균 +5.4% · +3% 지정가 도달 64% · 갭하락 출발 42% (50회)</td></tr>
            <tr><th>SOX 폭락 다음날 시가 매도</th><td>그냥 보유 대비 -0.13%p — 무익 (395회)</td></tr>
            <tr><th>눌림목 규칙</th><td>급변동 전반 +21.0% / 2025년 +4.3% / 평온한 2024년 +10.2%</td></tr>
            <tr><th>삼성전자·하이닉스 상관</th><td>최근 6개월 0.89 — 둘 다 보유해도 분산 효과 거의 없음</td></tr>
            <tr><th>감시주문(하루 이상 방치)</th><td>최악 -34.0% → -20.0%, -10% 넘는 손실 비율 4.8% → 2.4%</td></tr>
            <tr><th>감시주문(당일 재확인 가능)</th><td>오히려 불리 — 스치고 되돌아와 손해 94회 &gt; 손실 줄인 66회</td></tr>
          </tbody></table>
        </details>

        <div className="doc-sec doc-warn">
          <div className="doc-h">⑧ 믿으면 안 되는 것 (한계)</div>
          <ul className="doc-ul">
            <li><strong>&quot;매일 5% 수익&quot;은 불가능합니다.</strong> 기회가 있는 날은 96%였지만, 순진하게 추격하는 전략은 6개월 -54%였습니다.</li>
            <li><strong>과거 통계는 미래 보장이 아닙니다.</strong> 특히 표본이 적은 국면(예: 폭락바닥권 23회)은 우연의 영향이 큽니다.</li>
            <li><strong>구조적 리스크는 과거 가격에 없습니다.</strong> AI 업황 둔화, 전쟁, 환율 급등, 국채금리 변동은 5년 데이터에 없던 형태로 올 수 있습니다.</li>
            <li><strong>강세장 수익률을 지금에 적용하지 않습니다.</strong> 고점 대비 15% 이상 무너지면 &quot;보유가 유리했다&quot;는 판정을 자동으로 철회합니다.</li>
            <li><strong>예상 경로 차트는 &quot;방향&quot;이 아니라 &quot;폭&quot;의 그림</strong>입니다. 언제 어느 쪽으로 튈지는 어떤 통계 모델도 모릅니다. 또한 하루 안의 U자 배분은 자체 수집 표본이 부족해(20건) 시장에서 통상 관찰되는 표준 형태를 쓴 값이라, 장중 부분구간은 일 단위만큼 정밀하게 검증되지 않았습니다.</li>
            <li><strong>예약(감시)주문은 만능이 아닙니다.</strong> 하루 이상 못 볼 때는 꼬리 손실을 확실히 잘라주지만, 당일 안에 다시 확인할 수 있다면 잠깐 스치고 되돌아오는 날에 기계적으로 털려 오히려 손해였습니다(손해 94건 vs 구제 66건). 그래서 조건부로만 권합니다.</li>
            <li><strong>시세는 최대 15~20분 지연</strong>될 수 있습니다. 주문 직전 증권사 앱에서 반드시 재확인하세요.</li>
            <li><strong>플레이북은 수익 증폭기가 아니라 낙폭 방어 장치</strong>입니다. 최근 1개월 최대낙폭이 보유 34~43% vs 플레이북 8~11%였습니다.</li>
          </ul>
        </div>

        <details className="doc-sec">
          <summary className="doc-h">⑨ 직접 확인하기</summary>
          <div className="doc-code">npx tsx scripts/validate-volatility.ts</div>
          <div className="doc-cap">변동성 모델 적중률 — 실제 배포 코드를 그대로 호출해 검증</div>
          <div className="doc-code">npx tsx scripts/validate-modes.ts</div>
          <div className="doc-cap">작전 규칙 성적 — 4개 기간, 거래비용 차감, 최악 순서 가정</div>
          <div className="doc-code">npx tsx scripts/validate-holding.ts</div>
          <div className="doc-cap">매매 vs 보유 비교 — 1주/1개월/6개월</div>
          <div className="doc-code">npx tsx scripts/validate-forecast-path.ts</div>
          <div className="doc-cap">예상 경로 차트의 구간 적중률 + √시간 가정 점검</div>
          <div className="doc-code">npx tsx scripts/validate-power.ts</div>
          <div className="doc-cap">표본·조합 확대가 답을 바꾸는지 — 검정력·시계별·조합별 실험</div>
          <div className="doc-code">npx tsx scripts/validate-probability.ts</div>
          <div className="doc-cap">상승 확률 모델 3종 비교 — Brier·AUC·신뢰도·국면별 실측 상승률</div>
          <div className="doc-code">npx tsx scripts/validate-analog.ts</div>
          <div className="doc-cap">방향 예측 모델의 실패를 재현 — 적중률·확신도별 성적·변수별 기여도</div>
          <div className="doc-code">npx tsx scripts/validate-touch.ts</div>
          <div className="doc-cap">지정가 도달 확률 실측표 생성 ({touchStats.calibration[0].n.toLocaleString()}일)</div>
          <div className="doc-code">npx tsx scripts/validate-correlation-cap.ts</div>
          <div className="doc-cap">상관 비중 한도의 위험/수익 교환비 — 캡 수준별 최악의 날·최대낙폭</div>
          <div className="doc-code">npx tsx scripts/validate-watch-orders.ts</div>
          <div className="doc-cap">예약(감시)주문 효과 — 못 보는 기간 1/3/5거래일별 꼬리 손실 비교</div>
          <div className="doc-code">npx tsx scripts/validate-daily-stop.ts</div>
          <div className="doc-cap">하루 손실 한도의 효과 — 낙폭·샤프 개선과 기간별 견고성</div>
          <div className="doc-code">npx tsx scripts/validate-trading-rules.ts</div>
          <div className="doc-cap">손실 한도·상하한가/VI·성적표 채점 로직 회귀 테스트</div>
          <div className="doc-code">npx tsx scripts/validate-payload.ts</div>
          <div className="doc-cap">토큰을 줄이면서 AI에게 가는 사실이 그대로인지 — 종목·경고 누락 검사</div>
          <div className="doc-code">npx tsx scripts/validate-consistency.ts</div>
          <div className="doc-cap">화면 문장끼리 모순이 없는지 — 60개 시나리오에서 강도·판정·경고 교차 검사</div>
          <div className="doc-code">npx tsx scripts/validate-safety.ts</div>
          <div className="doc-cap">화면의 가격이 &quot;주문 가능한 값&quot;인지 — 시세가 깨져도 음수·NaN 손절가가 나오지 않는지</div>
          <div className="doc-code">npx tsx scripts/validate-news-parse.ts</div>
          <div className="doc-cap">뉴스 수집 60건이 실제로 60건으로 남는지 + 응답이 잘려도 살아남는지</div>
          <div className="doc-code">npx tsx scripts/build-scenarios.ts</div>
          <div className="doc-cap">국면별 통계 테이블 재생성</div>
        </details>
      </div>

      {/* 하단 고정 탭바 — 한 손 조작 기준으로 화면을 3개 영역으로 나눈다 */}
      <nav className="tabbar">
        <button className={tab === "오늘" ? "tabbar-btn active" : "tabbar-btn"} onClick={() => setTab("오늘")}>
          <span className="tabbar-icon">🎯</span>오늘 할 일
        </button>
        <button className={tab === "종목" ? "tabbar-btn active" : "tabbar-btn"} onClick={() => setTab("종목")}>
          <span className="tabbar-icon">📈</span>종목
        </button>
        <button className={tab === "정보" ? "tabbar-btn active" : "tabbar-btn"} onClick={() => setTab("정보")}>
          <span className="tabbar-icon">📰</span>뉴스·시장
        </button>
        <button className={tab === "분석방식" ? "tabbar-btn active" : "tabbar-btn"} onClick={() => setTab("분석방식")}>
          <span className="tabbar-icon">📚</span>분석 방식
        </button>
      </nav>
    </main>
  );
}
