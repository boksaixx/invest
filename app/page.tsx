"use client";

// 토스 스타일 대시보드: 현금/보유 입력 → 실시간 시세 → AI 매매 조언
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiAdvice, EngineSignal, MasterScore, NewsItem, Portfolio, Quote } from "@/lib/types";
import { STOCKS, TICKER_LIST } from "@/lib/types";
import ForecastChart from "./ForecastChart";
// 문서 탭이 인용하는 검증 수치는 반드시 실측 파일에서 읽는다.
// 코드에 숫자를 박아두면 데이터가 갱신될 때 앱이 조용히 낡은 값을 말하게 된다(과거에 실제로 겪음).
import analogStats from "@/data/analog-stats.json";
import touchStats from "@/data/touch-stats.json";
import probStats from "@/data/probability-stats.json";

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
function fmt(n: number | null | undefined, currency: "KRW" | "USD"): string {
  if (n == null || isNaN(n)) return "-";
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
  const [error, setError] = useState<string | null>(null);
  const [newsNotice, setNewsNotice] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, string> | null>(null);
  const [snapshotTime, setSnapshotTime] = useState<string | null>(null);
  const [snapshotMasterScore, setSnapshotMasterScore] = useState<MasterScore | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fontScaleIdx, setFontScaleIdx] = useState(1);
  const [fontScaleLoaded, setFontScaleLoaded] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
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
    void refreshMarket();
    void fetch("/api/snapshot")
      .then((r) => r.json())
      .then((j) => {
        if (j?.snapshot?.collectedAt) setSnapshotTime(j.snapshot.collectedAt);
        if (j?.snapshot?.masterScore) setSnapshotMasterScore(j.snapshot.masterScore as MasterScore);
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

  // "AI 정밀 분석"을 누르기 전에는 자동수집 스냅샷의 마스터 스코어를, 누른 뒤에는 방금 계산된 것을 보여준다.
  const displayMasterScore = result?.masterScore ?? snapshotMasterScore;
  const masterScoreIsLive = Boolean(result?.masterScore);

  return (
    <main className="container">
      <div className="header">
        <div>
          <h1>반도체 트레이딩 AI</h1>
          <div className="sub">
            국내 10종목 단타 어드바이저 (반도체 5 + 비반도체 5)
            {snapshotTime && ` · 자동수집 ${new Date(snapshotTime).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`}
          </div>
          {hostname && <div className="hostname-tag">접속 주소: {hostname}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button className="btn-ghost btn" style={{ width: "auto" }} onClick={() => setEditOpen((v) => !v)}>
            {editOpen ? "닫기" : "내 자산 입력"}
          </button>
          <button
            className="btn-ghost btn"
            style={{ width: "auto" }}
            onClick={async () => {
              await fetch("/api/auth", { method: "DELETE" });
              window.location.href = "/login";
            }}
          >
            로그아웃
          </button>
        </div>
      </div>

      {/* 저장소 자가진단 — localStorage 쓰기/읽기가 실패하면 자산정보·분석결과가 계속 초기화되는데,
          원인이 조용히 묻히지 않도록 화면에 명확히 알려준다 */}
      {storageBlocked && (
        <div className="storage-warning">
          <div className="storage-warning-title">⚠️ 이 브라우저에서 데이터 저장이 차단되어 있어요</div>
          <div className="storage-warning-body">
            자산 정보와 분석 결과가 계속 초기화되는 이유입니다. 아래를 확인해주세요.
          </div>
          <ul className="storage-warning-list">
            <li>시크릿 모드(프라이빗 브라우징)로 열려 있지 않은지 확인하세요 — 시크릿 모드는 탭을 닫으면 저장된 데이터가 전부 사라집니다.</li>
            <li>크롬 설정 → 사이트 설정 → 쿠키 및 사이트 데이터에서 이 사이트가 차단되어 있지 않은지 확인하세요.</li>
            <li>휴대폰 저장공간이 가득 차 있으면 브라우저가 저장을 거부할 수 있으니 공간을 확보해보세요.</li>
            <li>일부 폰의 "배터리/메모리 최적화" 기능이 브라우저 데이터를 강제로 지우기도 합니다 — 이 앱(또는 크롬)을 최적화 대상에서 제외해보세요.</li>
          </ul>
        </div>
      )}

      {/* 글자 크기 조절 — 가- / 가+ 로 전체 화면 글자 크기를 바꿀 수 있다 (다음에 켜도 유지됨) */}
      {/* ===== 탭: 오늘 ===== */}
      <div style={{ display: tab === "오늘" ? undefined : "none" }}>

      {/* 오늘의 작전 — 엔진이 장세(폭락장/급등과열/변동성확대/보통)를 스스로 판별해 그날의 플레이북 제시 */}
      {result?.todayPlan && (
        <div className={`plan-card plan-${result.todayPlan.regime}`}>
          <div className="plan-head">
            <span className={`plan-badge plan-badge-${result.todayPlan.regime}`}>{result.todayPlan.regime}</span>
            <span className="plan-regime-note">{result.todayPlan.regimeNote}</span>
          </div>
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
        </div>
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
      <div className="card">
        <div className="asset-label">총 자산 (현금 + 주식 평가금, 원화 환산)</div>
        <div className="asset-total">{won(totalAsset)}원</div>
        {investedCost > 0 && (
          <div className={`asset-pnl ${pctClass(totalPnl)}`}>
            평가손익 {totalPnl >= 0 ? "+" : ""}
            {won(totalPnl)}원 ({totalPnlPct >= 0 ? "+" : ""}
            {totalPnlPct.toFixed(2)}%)
          </div>
        )}
        <div className="hint">
          현금 {won(portfolio.cash)}원{portfolio.cashUSD > 0 && ` + $${won(portfolio.cashUSD)}`} · 주식 {won(holdingsValueKRW)}원
          {holdingsValueUSD > 0 && ` + $${won(holdingsValueUSD)}`}
        </div>
        {!usdKrwRate && (portfolio.cashUSD > 0 || holdingsValueUSD > 0) && (
          <div className="hint" style={{ color: "var(--red)" }}>
            환율 정보를 아직 못 가져와 달러 자산이 총 자산에 반영되지 않았어요 (잠시 후 자동 갱신).
          </div>
        )}
      </div>

      {/* 내 돈 기준 하루 변동 예상 — 종목별 %보다 "내 계좌가 얼마 흔들리나"가 훨씬 체감된다 */}
      {result?.portfolioRisk && portfolio.holdings.some((h) => h.qty > 0) && (
        <div className="risk-card">
          <div className="risk-title">💰 내 보유 기준 하루 예상 변동</div>
          <div className="risk-main">
            평가금 {manwon(result.portfolioRisk.totalValue)} 기준 하루 ±
            <strong>{manwon(result.portfolioRisk.sigmaDailyAmount)}</strong>
            <span className="risk-sub"> (±{result.portfolioRisk.sigmaDailyPct.toFixed(1)}%)</span>
          </div>
          <div className="risk-row">
            <span>20일에 한 번 겪는 나쁜 날</span>
            <strong style={{ color: "#c9353f" }}>{manwon(result.portfolioRisk.loss5Pct)}</strong>
          </div>
          <div className="risk-row">
            <span>100일에 한 번 오는 최악의 날</span>
            <strong style={{ color: "#c9353f" }}>{manwon(result.portfolioRisk.loss1Pct)}</strong>
          </div>
          <div className="risk-row">
            <span>실질 분산 효과</span>
            <strong>{result.portfolioRisk.effectiveBets.toFixed(1)}종목 수준</strong>
          </div>
          {result.portfolioRisk.warnings.map((w, i) => (
            <div key={i} className="risk-warn">⚠️ {w}</div>
          ))}
          {/* 상관 합산 비중 한도 — 종목당 한도만으로는 "상관 0.9인 두 종목에 반반"이 안 걸러진다 */}
          {result.correlationCap?.warnings.map((w, i) => (
            <div key={`cc${i}`} className="risk-warn">⚠️ {w}</div>
          ))}
          <div className="risk-note">
            과거 5년 실데이터로 검증한 추정치입니다(90% 구간 적중률 약 88%). 확정 예측이 아니라 "이 정도 범위는 각오해야 한다"는 기준으로만 쓰세요.
          </div>
        </div>
      )}

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
          {staleness(result.generatedAt, "분석")} · 화면을 껐다 켜도 이 결과는 유지돼요. 새 판단이 필요하면 다시 분석하기를 눌러주세요.
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
        <div className="card" style={{ fontSize: 13, color: "var(--text-sub)" }}>
          ANTHROPIC_API_KEY가 설정되지 않아 룰 엔진 신호만 표시합니다. Vercel 환경변수에 키를 추가하면 AI 종합 판단이 활성화됩니다.
        </div>
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
            실시간 뉴스·속보
            <span className="meta">{result.newsLive ? "실시간 수집" : "최근 자동수집분"}</span>
          </div>
          <div className="card">
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
          </div>
        </>
      )}

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
      {/* 종목 카드 */}
      {TICKERS.map(({ ticker, name }) => {
        const currency = STOCKS[ticker].currency;
        const q = market?.quotes?.[ticker];
        const sig = result?.signals.find((s) => s.ticker === ticker);
        const ai = result?.advice?.stocks.find((s) => s.ticker === ticker || s.ticker.includes(ticker));
        const h = portfolio.holdings.find((x) => x.ticker === ticker);
        const held = Boolean(h && h.qty > 0);
        const action = ai?.action ?? sig?.action;
        const info = computeScoreInfo(held, sig, ai);
        const isOpen = expanded.has(ticker);
        // 행동이 필요한 종목(보유 중이거나 매수/매도 신호)만 기본으로 펼친다
        const worthOpening = held || (action != null && action !== "관망" && action !== "보유");
        const open = cardOpen[ticker] ?? worthOpening;
        return (
          <div className="card" key={ticker}>
            <div className="stock-head">
              <div>
                <span className="stock-name">{name}</span>
                <span className="stock-code">{ticker}</span>
                <div className="stock-price">{fmt(q?.price ?? sig?.price, currency)}</div>
                <div className={`stock-change ${pctClass(q?.changePct)}`}>
                  {q ? `${q.change >= 0 ? "▲" : "▼"} ${fmt(Math.abs(q.change), currency)} (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%)` : "시세 로딩 중…"}
                </div>
                {q?.time && <div className="hint" style={{ marginTop: 2 }}>{staleness(q.time)}</div>}
              </div>
              <div className="stock-head-right">
                {action && <span className={badgeClass(action)}>{action}</span>}
                <button
                  className="card-toggle"
                  aria-expanded={open}
                  onClick={() => setCardOpen((p) => ({ ...p, [ticker]: !open }))}
                >
                  {open ? "접기 ▲" : "자세히 ▼"}
                </button>
              </div>
            </div>

            {/* 접힌 상태에서도 판단에 필요한 한 줄은 남긴다 — 다 접고 나서 아무것도 모르면 의미가 없다 */}
            {!open && (
              <div className="card-collapsed">
                {info && (
                  <span className={`cc-score ${info.tone}`}>
                    {info.score}/10 {info.label}
                  </span>
                )}
                {held && h && <span className="cc-item">보유 {h.qty}주{sig?.pnlPct != null && ` (${sig.pnlPct >= 0 ? "+" : ""}${sig.pnlPct}%)`}</span>}
                {sig?.forecastPath?.orderLevels && (
                  <span className="cc-item">
                    {action === "손절" || action === "전량매도" || action === "부분매도"
                      ? `정리 지정가 ${fmt(sig.forecastPath.orderLevels.sellPrice, currency)}`
                      : `지정가 매수 ${fmt(sig.forecastPath.orderLevels.buyPrice, currency)} / 매도 ${fmt(sig.forecastPath.orderLevels.sellPrice, currency)}`}
                  </span>
                )}
              </div>
            )}

            {held && (
              <div className="kv-row">
                <span className="k">내 보유</span>
                <span className="v">
                  {h!.qty}주 · 평단 {fmt(h!.avgPrice, currency)}
                  {sig?.pnlPct != null && (
                    <span className={pctClass(sig.pnlPct)}>
                      {" "}({sig.pnlPct >= 0 ? "+" : ""}{sig.pnlPct}%)
                    </span>
                  )}
                </span>
              </div>
            )}

            {open && (<>
            {/* 0~10점 매수/매도 강도 — 가장 먼저 봐야 하는 숫자 */}
            {info && (
              <div className="score-panel">
                <div className={`score-circle ${info.tone}`}>
                  <span className="num">{info.score}</span>
                  <span className="denom">/10 {info.label}</span>
                </div>
                <div className="score-text">
                  <div className="score-action">{info.oneLiner}</div>
                  <div className="score-bar-track">
                    <div className={`score-bar-fill ${info.tone}`} style={{ width: `${info.score * 10}%` }} />
                  </div>
                  {sig?.verdict && <div className="score-sub">{sig.verdict}</div>}
                </div>
              </div>
            )}

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
        );
      })}

      </div>{/* ===== /탭: 종목 2구간 ===== */}

      {/* ===== 탭: 분석 방식 — 어떤 변수를 어떻게 쓰는지 전부 공개 ===== */}
      <div style={{ display: tab === "분석방식" ? undefined : "none" }}>
        <div className="doc-intro">
          이 앱이 <strong>무엇을 보고</strong>, <strong>어떻게 판단하며</strong>, <strong>어디까지 믿을 수 있는지</strong>를
          전부 공개합니다. 숫자는 모두 5개년 실데이터로 검증한 값이며, 검증 스크립트로 언제든 재현할 수 있습니다.
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
              ["실시간 속보(Gemini)", "3시간 이내 고영향 뉴스 우선. 트럼프 등 정치인 관세·규제 발언, AI 업황, 전쟁·지정학"],
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

        <div className="doc-sec">
          <div className="doc-h">② 어떻게 예측하나 — 4단계</div>
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
        </div>

        <details className="doc-sec">
          <summary className="doc-h">③ 변수는 서로 어떻게 얽혀 있나 (상관관계와 반영 경로)</summary>
          <div className="doc-flow">
            {[
              {
                src: "간밤 미국 SOX 지수",
                rel: "국내 반도체주와 상관 0.33~0.43 (같은 날짜 SOX보다 2배 강함)",
                into: "① 변동성 추정에서 예상 등락폭을 넓히고 → ② 장세 판별(폭락장/급등과열) 기준이 되며 → ③ 매크로 점수로 개별 종목 점수에 직접 가산·감산",
              },
              {
                src: "뉴스 (Gemini 실시간)",
                rel: "고임팩트 악재는 기술적 신호를 무효화. 뉴스 감성 점수가 기술 점수와 어긋나면 보수적으로 채택",
                into: "① 뉴스 감성 점수로 종목 점수에 반영 → ② 과열 교차검증(기술적 매수 신호라도 악재가 있으면 진입 보류) → ③ Claude가 구조적 리스크로 인용",
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
          <summary className="doc-h">④ 우리가 시도했다가 버린 것 (실패 기록)</summary>
          <div className="doc-fail">
            <div className="doc-fail-t">방향 예측 — 세 번 만들고 세 번 실패했습니다</div>
            <div style={{ marginBottom: 10 }}>
              &quot;오늘 오를 확률이 몇 %인가&quot;에 답하려고 서로 다른 방식으로 세 번 모델을 만들었습니다.
              <table className="doc-tbl" style={{ marginTop: 6 }}><tbody>
                <tr><th>① 유사패턴 kNN (단일 시간대)</th><td>적중률 {analogStats.accuracyPct}% — 기준선 {analogStats.baselineMajorityPct}%에 미달</td></tr>
                <tr><th>② 다중 시간대 로지스틱</th><td>3일·1주·2주·1개월·6개월·3년 수익률 + 변동성 국면 + 낙폭 + 이격 + RSI + 거래량 + 간밤 SOX + 전일 코스피 <b>13개 특징, 표본 {probStats.sample.toLocaleString()}개</b> → Brier {probStats.models["로지스틱(다중 시간대)"].brier} (기저율과 <b>완전히 동일</b>), AUC {probStats.models["로지스틱(다중 시간대)"].auc} = 정보량 0</td></tr>
                <tr><th>③ 국면 조건부 (21개 국면)</th><td>다중검정 보정 후 기저율과 유의미하게 다른 국면 <b>{probStats.significantRegimes}개</b></td></tr>
              </tbody></table>
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
          <summary className="doc-h">⑤ 검증된 숫자</summary>
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
          <div className="doc-h">⑥ 믿으면 안 되는 것 (한계)</div>
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
          <summary className="doc-h">⑦ 직접 확인하기</summary>
          <div className="doc-code">npx tsx scripts/validate-volatility.ts</div>
          <div className="doc-cap">변동성 모델 적중률 — 실제 배포 코드를 그대로 호출해 검증</div>
          <div className="doc-code">npx tsx scripts/validate-modes.ts</div>
          <div className="doc-cap">작전 규칙 성적 — 4개 기간, 거래비용 차감, 최악 순서 가정</div>
          <div className="doc-code">npx tsx scripts/validate-holding.ts</div>
          <div className="doc-cap">매매 vs 보유 비교 — 1주/1개월/6개월</div>
          <div className="doc-code">npx tsx scripts/validate-forecast-path.ts</div>
          <div className="doc-cap">예상 경로 차트의 구간 적중률 + √시간 가정 점검</div>
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
