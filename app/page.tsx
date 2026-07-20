"use client";

// 토스 스타일 대시보드: 현금/보유 입력 → 실시간 시세 → AI 매매 조언
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiAdvice, EngineSignal, MasterScore, NewsItem, Portfolio, Quote } from "@/lib/types";
import { STOCKS, TICKER_LIST } from "@/lib/types";

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
  relativeStrengthSummary?: string | null;
  sectorConcentrationWarning?: string | null;
  generatedAt: string;
  error?: string;
}

const DEFAULT_PORTFOLIO: Portfolio = { cash: 20_000_000, holdings: [] };
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
function loadPortfolio(): Portfolio {
  if (typeof window === "undefined") return DEFAULT_PORTFOLIO;
  try {
    const raw = localStorage.getItem("portfolio-v1");
    if (raw) return JSON.parse(raw) as Portfolio;
  } catch {}
  const fromCookie = readPortfolioCookie();
  if (fromCookie) {
    try {
      localStorage.setItem("portfolio-v1", JSON.stringify(fromCookie));
    } catch {}
    return fromCookie;
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

function won(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "-";
  return Math.round(n).toLocaleString("ko-KR");
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

function staleness(iso: string | undefined): string | null {
  if (!iso) return null;
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return "방금 전 시세";
  if (diffMin > 60) return `${Math.round(diffMin / 60)}시간 전 시세 (지연 큼 — 주문 전 재확인 필수)`;
  if (diffMin >= 15) return `${diffMin}분 전 시세 (지연 가능성 — 주문 전 재확인 권장)`;
  return `${diffMin}분 전 시세`;
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
function computeScoreInfo(holding: boolean, sig: EngineSignal | undefined, ai: AiAdvice["stocks"][number] | undefined): ScoreInfo | null {
  if (!sig) return null;
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
    setPortfolio(loadPortfolio());
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

  const holdingsValue = useMemo(() => {
    let sum = 0;
    for (const h of portfolio.holdings) {
      const q = market?.quotes?.[h.ticker];
      sum += h.qty * (q?.price ?? h.avgPrice);
    }
    return sum;
  }, [portfolio, market]);

  const investedCost = useMemo(
    () => portfolio.holdings.reduce((a, h) => a + h.qty * h.avgPrice, 0),
    [portfolio],
  );
  const totalAsset = portfolio.cash + holdingsValue;
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
    { key: "nikkei", label: "니케이" },
    { key: "shanghai", label: "상해" },
  ];

  const fearGreed = (market?.macro as { fearGreed?: { value: number; ratingKo: string } } | undefined)?.fearGreed;

  // 5종목 중 "지금 뭘 해야 하나"를 강도순으로 정렬한 요약 — 화면 맨 위에서 바로 판단할 수 있게
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
            반도체 5종목 단타 어드바이저
            {snapshotTime && ` · 자동수집 ${new Date(snapshotTime).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`}
          </div>
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

      {/* 글자 크기 조절 — 가- / 가+ 로 전체 화면 글자 크기를 바꿀 수 있다 (다음에 켜도 유지됨) */}
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

      {/* 마스터 스코어: 5종목+매크로 종합 "오늘의 매수 매력도" — AI 호출 없이 항상 즉시 계산됨 */}
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

      {/* 총 자산 */}
      <div className="card">
        <div className="asset-label">총 자산 (현금 + 주식 평가금)</div>
        <div className="asset-total">{won(totalAsset)}원</div>
        {investedCost > 0 && (
          <div className={`asset-pnl ${pctClass(totalPnl)}`}>
            평가손익 {totalPnl >= 0 ? "+" : ""}
            {won(totalPnl)}원 ({totalPnlPct >= 0 ? "+" : ""}
            {totalPnlPct.toFixed(2)}%)
          </div>
        )}
        <div className="hint">
          현금 {won(portfolio.cash)}원 · 주식 {won(holdingsValue)}원
        </div>
      </div>

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
          {TICKERS.map(({ ticker, name }) => {
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
                    inputMode="numeric"
                    placeholder="0"
                    value={h ? h.avgPrice.toLocaleString("ko-KR") : ""}
                    onChange={(e) => {
                      const v = Number(e.target.value.replace(/[^0-9]/g, ""));
                      update(isNaN(v) ? 0 : v, h?.qty ?? 0);
                    }}
                  />
                  <span className="input-suffix">원</span>
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

      {/* 장 상태 + 상대강도 + 섹터집중도 배너 */}
      {result?.marketPhase && (
        <div className="phase-banner">
          <span className="phase-tag">{result.marketPhase.phase}</span>
          <span className="phase-time">{result.marketPhase.kstTime} KST</span>
          <span className="phase-note">{result.marketPhase.note}</span>
        </div>
      )}
      {result?.relativeStrengthSummary && <div className="rs-banner">⚖️ {result.relativeStrengthSummary}</div>}
      {result?.sectorConcentrationWarning && (
        <div className="rs-banner" style={{ background: "var(--red-weak)", color: "#c9353f" }}>
          🎯 {result.sectorConcentrationWarning}
        </div>
      )}

      {/* AI 분석 버튼 */}
      <button className="btn btn-primary" onClick={() => void runAnalysis()} disabled={loading} style={{ marginBottom: 14 }}>
        {loading ? (
          <>
            <span className="spinner" />
            AI 분석 중… {elapsed}초 (보통 30초~2분 걸려요)
          </>
        ) : (
          "지금 AI 정밀 분석 받기"
        )}
      </button>
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

      {/* 지금 뭘 해야 하나 — 5종목 강도순 랭킹 (핵심 요약) */}
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
              미보유 종목은 매수 강도, 보유 종목은 매도 강도입니다. 8점 이상이면 강한 신호, 4~7점은 조건부(트리거·목표가 확인), 0~3점은 아직 근거 부족(관망/보유)이에요.
            </div>
          </div>
        </>
      )}

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

      {/* 종목 카드 */}
      {TICKERS.map(({ ticker, name }) => {
        const q = market?.quotes?.[ticker];
        const sig = result?.signals.find((s) => s.ticker === ticker);
        const ai = result?.advice?.stocks.find((s) => s.ticker === ticker || s.ticker.includes(ticker));
        const h = portfolio.holdings.find((x) => x.ticker === ticker);
        const held = Boolean(h && h.qty > 0);
        const action = ai?.action ?? sig?.action;
        const info = computeScoreInfo(held, sig, ai);
        const isOpen = expanded.has(ticker);
        return (
          <div className="card" key={ticker}>
            <div className="stock-head">
              <div>
                <span className="stock-name">{name}</span>
                <span className="stock-code">{ticker}</span>
                <div className="stock-price">{won(q?.price ?? sig?.price)}원</div>
                <div className={`stock-change ${pctClass(q?.changePct)}`}>
                  {q ? `${q.change >= 0 ? "▲" : "▼"} ${won(Math.abs(q.change))}원 (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%)` : "시세 로딩 중…"}
                </div>
                {q?.time && <div className="hint" style={{ marginTop: 2 }}>{staleness(q.time)}</div>}
              </div>
              {action && <span className={badgeClass(action)}>{action}</span>}
            </div>

            {held && (
              <div className="kv-row">
                <span className="k">내 보유</span>
                <span className="v">
                  {h!.qty}주 · 평단 {won(h!.avgPrice)}원
                  {sig?.pnlPct != null && (
                    <span className={pctClass(sig.pnlPct)}>
                      {" "}({sig.pnlPct >= 0 ? "+" : ""}{sig.pnlPct}%)
                    </span>
                  )}
                </span>
              </div>
            )}

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
                {!held && (ai?.entryPrice ?? sig.suggestedEntryPrice) != null && (
                  <div className="kv-row">
                    <span className="k">매수 진입가</span>
                    <span className="v">{won(ai?.entryPrice ?? sig.suggestedEntryPrice)}원</span>
                  </div>
                )}
                {(ai?.targetPrice ?? sig.targetPrice) != null && (
                  <div className="kv-row">
                    <span className="k">{held ? "목표가 (여기서 매도 고려)" : "매수 시 목표가"}</span>
                    <span className="v up">{won(ai?.targetPrice ?? sig.targetPrice)}원</span>
                  </div>
                )}
                {(ai?.stopPrice ?? sig.stopPrice) != null && (
                  <div className="kv-row">
                    <span className="k">손절가 (반드시 지키세요)</span>
                    <span className="v down">{won(ai?.stopPrice ?? sig.stopPrice)}원</span>
                  </div>
                )}
                {sig.suggestedQty != null && (action === "신규매수" || action === "추가매수") && (
                  <div className="kv-row">
                    <span className="k">제안 매수 규모</span>
                    <span className="v">약 {sig.suggestedQty}주 ({won(sig.suggestedBudget)}원)</span>
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
                    <span className="v" style={{ color: "var(--text-weak)" }}>약 {won(sig.estimatedRoundTripCostWon)}원</span>
                  </div>
                )}
                <div className="kv-row">
                  <span className="k">RSI / 20일선</span>
                  <span className="v">
                    {sig.indicators.rsi14.toFixed(0)} / {won(sig.indicators.ma20)}원
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
                        <div className="ic-value">{won(sig.intraday.vwap)}원</div>
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
                          {won(sig.intraday.openingRangeLow)}~{won(sig.intraday.openingRangeHigh)}원
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
                  sig.scaledExit.length > 0 ||
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
                            ▸ {won(o.price)}원 · {o.qty}주 — {o.note}
                          </div>
                        ))}
                      </div>
                    )}
                    {sig.scaledExit.length > 0 && (
                      <div className="plan-block">
                        <div className="plan-block-title">분할 매도(익절) 라인</div>
                        {sig.scaledExit.map((o, i) => (
                          <div className="plan-item" key={i}>
                            ▸ {won(o.price)}원 · {o.qty}주 — {o.note}
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
                    {!held && sig.entryPriceBasis && (
                      <div className="reason">📍 매수 진입가 근거: {sig.entryPriceBasis}</div>
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
          </div>
        );
      })}

      <div className="disclaimer">
        본 서비스는 투자 판단을 돕는 참고 정보이며, 투자 권유나 수익 보장이 아닙니다.
        <br />
        모든 투자의 최종 결정과 책임은 투자자 본인에게 있습니다. 단기 매매는 원금 손실 위험이 큽니다.
        <br />
        <strong>무료 공개 API 기반 시세는 최대 15~20분 지연될 수 있습니다.</strong> 실제 주문 직전에는 반드시 증권사 앱(MTS)에서 최신 호가를 확인하세요. 진입/무효화 조건은 고정 가격이 아니라 &quot;조건 충족 여부&quot;로 판단하도록 설계되어 지연의 영향을 줄였지만, 완전히 없앨 수는 없습니다.
        <br />
        목표가·손절가는 왕복 거래비용(증권거래세+수수료, 약 0.25%)을 반영하지 않은 값입니다. 실제 순수익은 표시된 수치보다 낮습니다.
      </div>
    </main>
  );
}
