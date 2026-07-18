"use client";

// 토스 스타일 대시보드: 현금/보유 입력 → 실시간 시세 → AI 매매 조언
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiAdvice, EngineSignal, NewsItem, Portfolio, Quote, StockTicker } from "@/lib/types";

const TICKERS: { ticker: StockTicker; name: string }[] = [
  { ticker: "005930", name: "삼성전자" },
  { ticker: "000660", name: "SK하이닉스" },
];

interface MarketData {
  quotes: Record<string, Quote | null>;
  macro: Record<string, Quote | null>;
  fetchedAt: string;
}

interface AdviceResponse {
  signals: EngineSignal[];
  advice: AiAdvice | null;
  adviceError?: string | null;
  news: NewsItem[];
  aiAvailable: boolean;
  newsLive: boolean;
  generatedAt: string;
  error?: string;
}

const DEFAULT_PORTFOLIO: Portfolio = { cash: 20_000_000, holdings: [] };

function loadPortfolio(): Portfolio {
  if (typeof window === "undefined") return DEFAULT_PORTFOLIO;
  try {
    const raw = localStorage.getItem("portfolio-v1");
    if (!raw) return DEFAULT_PORTFOLIO;
    return JSON.parse(raw) as Portfolio;
  } catch {
    return DEFAULT_PORTFOLIO;
  }
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

export default function Home() {
  const [portfolio, setPortfolio] = useState<Portfolio>(DEFAULT_PORTFOLIO);
  const [market, setMarket] = useState<MarketData | null>(null);
  const [result, setResult] = useState<AdviceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, string> | null>(null);
  const [snapshotTime, setSnapshotTime] = useState<string | null>(null);

  // 초기 로드
  useEffect(() => {
    setPortfolio(loadPortfolio());
    void refreshMarket();
    void fetch("/api/snapshot")
      .then((r) => r.json())
      .then((j) => {
        if (j?.snapshot?.collectedAt) setSnapshotTime(j.snapshot.collectedAt);
      })
      .catch(() => {});
    const t = setInterval(() => void refreshMarket(), 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savePortfolio = useCallback((p: Portfolio) => {
    setPortfolio(p);
    try {
      localStorage.setItem("portfolio-v1", JSON.stringify(p));
    } catch {}
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
    setHealth(null);
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    try {
      const res = await fetch("/api/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolio }),
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
    { key: "nikkei", label: "니케이" },
    { key: "shanghai", label: "상해" },
  ];

  return (
    <main className="container">
      <div className="header">
        <div>
          <h1>반도체 트레이딩 AI</h1>
          <div className="sub">
            삼성전자 · SK하이닉스 단타 어드바이저
            {snapshotTime && ` · 자동수집 ${new Date(snapshotTime).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`}
          </div>
        </div>
        <button className="btn-ghost btn" style={{ width: "auto" }} onClick={() => setEditOpen((v) => !v)}>
          {editOpen ? "닫기" : "내 자산 입력"}
        </button>
      </div>

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
              const next =
                qty > 0 ? [...rest, { ticker, avgPrice, qty }] : rest;
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
      </div>

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
      {result && !result.aiAvailable && (
        <div className="card" style={{ fontSize: 13, color: "var(--text-sub)" }}>
          ANTHROPIC_API_KEY가 설정되지 않아 룰 엔진 신호만 표시합니다. Vercel 환경변수에 키를 추가하면 AI 종합 판단이 활성화됩니다.
        </div>
      )}

      {/* 종목 카드 */}
      {TICKERS.map(({ ticker, name }) => {
        const q = market?.quotes?.[ticker];
        const sig = result?.signals.find((s) => s.ticker === ticker);
        const ai = result?.advice?.stocks.find((s) => s.ticker === ticker || s.ticker.includes(ticker));
        const h = portfolio.holdings.find((x) => x.ticker === ticker);
        const action = ai?.action ?? sig?.action;
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
              </div>
              {action && <span className={badgeClass(action)}>{action}</span>}
            </div>

            {h && h.qty > 0 && (
              <div className="kv-row">
                <span className="k">내 보유</span>
                <span className="v">
                  {h.qty}주 · 평단 {won(h.avgPrice)}원
                  {sig?.pnlPct != null && (
                    <span className={pctClass(sig.pnlPct)}>
                      {" "}({sig.pnlPct >= 0 ? "+" : ""}{sig.pnlPct}%)
                    </span>
                  )}
                </span>
              </div>
            )}

            {sig && (
              <>
                <div className="kv-row">
                  <span className="k">신호 점수</span>
                  <span className="v">{sig.score}점 / 100 (신뢰도 {ai?.confidence ?? sig.confidence})</span>
                </div>
                {(ai?.targetPrice ?? sig.targetPrice) != null && (
                  <div className="kv-row">
                    <span className="k">목표가</span>
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
                <div className="kv-row">
                  <span className="k">RSI / 20일선</span>
                  <span className="v">
                    {sig.indicators.rsi14.toFixed(0)} / {won(sig.indicators.ma20)}원
                  </span>
                </div>
              </>
            )}

            {ai && (
              <div className="reason-list">
                <div className="reason" style={{ background: "var(--blue-weak)", color: "#1b64da", fontWeight: 700 }}>
                  💡 {ai.headline}
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
            {!ai && sig && (
              <div className="reason-list">
                {sig.reasons.slice(0, 4).map((r, i) => (
                  <div className="reason" key={i}>{r}</div>
                ))}
                {sig.warnings.slice(0, 3).map((w, i) => (
                  <div className="reason warn" key={i}>⚠️ {w}</div>
                ))}
              </div>
            )}
            {!sig && !loading && (
              <div className="hint">위의 &quot;AI 정밀 분석&quot; 버튼을 누르면 매수/매도 타이밍 조언이 표시됩니다.</div>
            )}
          </div>
        );
      })}

      {/* 뉴스 */}
      {result && result.news.length > 0 && (
        <>
          <div className="section-title">
            주요 뉴스·이슈
            <span className="meta">{result.newsLive ? "실시간 수집" : "최근 자동수집분"}</span>
          </div>
          <div className="card">
            {result.news.map((n, i) => (
              <div className="news-item" key={i}>
                <div className="news-title">{n.title}</div>
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
      </div>
    </main>
  );
}
