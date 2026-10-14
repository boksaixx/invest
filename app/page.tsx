"use client";

// 내 주식 비서 — 삼성전자·SK하이닉스 2종목 (2026-10 개편)
//
// 화면 원칙
//  · 종목마다 "지금 할 일" 한 줄과 숫자(얼마에·몇 주·어디서 자를지)만 크게. 나머지는 접어 둔다.
//  · 앱을 열면 바로 판단이 나온다(AI 호출 없음, /api/quick 2~4초). 장중에는 1분마다 저절로 갱신.
//  · 확률 옆에는 항상 "과거 비슷한 상황 몇 번 중 몇 %"를 붙인다 — 믿을지 말지는 숫자로 판단하게.
//  · 입력은 현금 + 종목별 수량·평단 3칸뿐. 안 넣어도 쓸 수 있다(1,000만원 기준으로 수량 계산).
//  · 시황(간밤 미국·지금 시장)과 종목별 국면(추세·변동성)을 보여 주고, 그 국면에서 신호가 얼마나 맞았는지 붙인다.
//  · "AI 심층 분석"(/api/deep)은 버튼을 눌렀을 때만 — 같은 숫자를 받은 AI가 시황→추세→수급→뉴스→결론→시나리오로 정리.
//    AI는 결론을 뒤집지 못하고(가드레일), AI의 방향도 그날 종가로 따로 채점한다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Decision, ProbView } from "@/lib/decide";
import type { DeepAnalysis, DeepStock } from "@/lib/deepAnalysis";

type StockKey = "005930" | "000660";
const NAMES: Record<StockKey, string> = { "005930": "삼성전자", "000660": "SK하이닉스" };
const KEYS: StockKey[] = ["005930", "000660"];
const PF_KEY = "my-portfolio-v2";
const LOG_KEY = "signal-log-v2";
const DEEP_KEY = "deep-analysis-v1";
const DEFAULT_CASH = 10_000_000;

interface Holding {
  qty: number;
  avgPrice: number;
}
interface Portfolio {
  cash: number;
  holdings: Partial<Record<StockKey, Holding>>;
  known: boolean; // 사용자가 직접 입력했는지
}
interface RegimeLine {
  label: string;
  value: string;
  detail: string;
  tone: "up" | "down" | "flat";
}
interface StockRes {
  ticker: StockKey;
  name: string;
  error?: string;
  price: number;
  change: number;
  changePct: number;
  quoteTime: string;
  today: { open: number; high: number; low: number; vwap: number } | null;
  decision: Decision;
  prediction: { checkpoint: string | null; dayProb: number | null; swingProb: number | null; swingReasons: string[]; sigmaDailyPct: number | null };
  engine: { stopPrice: number | null; breakEvenPrice: number | null; pnlPct: number | null; volRegime: string | null };
  flows5: { foreign: number; inst: number; indiv: number; days: number } | null;
  news: { title: string; sentiment: string; isBreaking: boolean }[];
  recentCloses: { d: string; o?: number; c: number }[];
  regime?: { headline: string; lines: RegimeLine[]; edge: { key: string; text: string; auc: number; n: number; better: boolean | null } | null };
}
interface QuickRes {
  error?: string;
  updatedAt: string;
  phase: { phase: string; kstTime: string; note: string };
  market: {
    kospi: { price: number; changePct: number } | null;
    usdkrw: { price: number; changePct: number } | null;
    nvda: { changePct: number } | null;
    sox: { changePct: number } | null;
    mu?: { changePct: number } | null;
    nq?: { price: number; changePct: number } | null;
    usDate: string | null;
    regime?: RegimeLine[];
  };
  account: { cash: number; totalAsset: number; todayPnlWon: number; todayPnlPct: number; dailyStop: boolean; dailyWarn: boolean };
  stocks: StockRes[];
  newsAgeMin: number | null;
  model: {
    generatedAt: string;
    dataRange: { daily: string; hourly: string; flows: string };
    dayHit: { n: number; hitPct: number; naivePct: number } | null;
    dayPeriod: string;
    swingAuc: number;
    swingHit: { n: number; hitPct: number; naivePct: number } | null;
    swingDays: number;
    openByYear?: { year: string; n: number; auc: number }[];
    byRegime?: { key: string; label: string; n: number; auc: number; hit: { n: number; hitPct: number; naivePct: number } | null }[];
  };
}
interface LogEntry {
  id: string;
  ticker: StockKey;
  date: string; // KST 날짜
  time: string; // HH:MM
  price: number;
  dir: 1 | -1;
  prob: number;
  src?: "model" | "ai"; // 없으면 model (이전 기록)
  atOpen?: boolean; // 장전 신호 — 시가에서 종가까지로 채점
  result?: { close: number; hit: boolean; base?: number };
}

// ── 작은 도구 ──────────────────────────────────────────────
const won = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "-" : `${Math.round(n).toLocaleString("ko-KR")}원`);
const manwon = (n: number) => (Math.abs(n) >= 1e8 ? `${(n / 1e8).toFixed(n % 1e8 === 0 ? 0 : 2)}억원` : `${Math.round(n / 1e4).toLocaleString("ko-KR")}만원`);
const sgn = (x: number, d = 2) => `${x > 0 ? "+" : ""}${x.toFixed(d)}%`;
const cls = (x: number) => (x > 0 ? "up" : x < 0 ? "down" : "flat");
const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const kstHM = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(11, 16);
const digits = (s: string) => Number(s.replace(/[^\d]/g, "")) || 0;
const fmtInput = (n: number) => (n > 0 ? n.toLocaleString("ko-KR") : "");

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 저장 실패는 조용히 — 다음에 다시 입력하면 된다
  }
}

// 자산 정보 불러오기 — 이전 버전(portfolio-v1, 쿠키 백업 포함)에 넣어 둔 값이 있으면 2종목만 옮겨 온다.
// iOS 홈 화면 앱은 저장소가 예고 없이 비는 일이 있어 1년짜리 쿠키를 이중 백업으로 둔다(이전 버전과 같은 방식).
const PF_COOKIE = "my-portfolio-v2-backup";
function readCookie(name: string): string | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}
function loadPortfolio(): Portfolio {
  const empty: Portfolio = { cash: 0, holdings: {}, known: false };
  const v2 = loadJSON<Portfolio | null>(PF_KEY, null) ?? (() => {
    try {
      const c = readCookie(PF_COOKIE);
      return c ? (JSON.parse(c) as Portfolio) : null;
    } catch {
      return null;
    }
  })();
  if (v2 && typeof v2.cash === "number") return { cash: v2.cash, holdings: v2.holdings ?? {}, known: v2.known !== false };
  try {
    const raw = localStorage.getItem("portfolio-v1") ?? readCookie("portfolio-v1-backup");
    if (!raw) return empty;
    const old = JSON.parse(raw) as { cash?: number; holdings?: { ticker: string; qty: number; avgPrice: number }[] };
    const holdings: Portfolio["holdings"] = {};
    for (const h of old.holdings ?? []) {
      if ((h.ticker === "005930" || h.ticker === "000660") && h.qty > 0 && h.avgPrice > 0) holdings[h.ticker] = { qty: Math.floor(h.qty), avgPrice: h.avgPrice };
    }
    return { cash: Math.max(0, Number(old.cash) || 0), holdings, known: true };
  } catch {
    return empty;
  }
}
function persistPortfolio(p: Portfolio) {
  saveJSON(PF_KEY, p);
  try {
    document.cookie = `${PF_COOKIE}=${encodeURIComponent(JSON.stringify(p))}; max-age=31536000; path=/; SameSite=Lax`;
  } catch {
    // 쿠키 실패는 무시
  }
}

const Ico = {
  refresh: (p: { spin?: boolean }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className={p.spin ? "spin" : undefined}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  ),
  chev: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  home: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3 3 10.2V21h6.5v-6h5v6H21V10.2z" />
    </svg>
  ),
  chart: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  ),
  help: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3M12 17h.01" />
    </svg>
  ),
};

// ── 확률 막대 ──────────────────────────────────────────────
function ProbBar({ v, title }: { v: ProbView; title: string }) {
  const pct = Math.round(v.prob * 100);
  const color = v.weak ? "#b0b8c1" : v.tone === "up" ? "var(--red)" : v.tone === "down" ? "var(--blue)" : "#b0b8c1";
  return (
    <div className={`prob${v.weak ? " weak" : ""}`}>
      <div className="prob-head">
        <div className="prob-title">
          {title}
          <small>{v.horizon}</small>
          {v.weak && <span className="tag">참고용</span>}
        </div>
        <div className="prob-pct" style={{ color: v.weak ? undefined : color }}>
          오를 확률 {pct}%
        </div>
      </div>
      <div className="bar" aria-hidden>
        <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
        <div className="bar-mid" />
      </div>
      <div className="prob-label" style={{ color: v.weak ? "var(--weak)" : color === "#b0b8c1" ? "var(--sub)" : color }}>
        {v.label}
      </div>
      {v.stat && <div className="prob-stat">{v.stat}</div>}
    </div>
  );
}

// ── 종목 카드 ──────────────────────────────────────────────
function StockCard({ s, pf, onEdit, assumed }: { s: StockRes; pf: Portfolio; onEdit: () => void; assumed: boolean }) {
  const [open, setOpen] = useState(false);
  if (s.error) {
    return (
      <div className="card">
        <div className="stock-name">{s.name}</div>
        <div className="verdict wait">
          <div className="verdict-title">잠시 후 다시</div>
          <div className="verdict-sum">{s.error}</div>
        </div>
      </div>
    );
  }
  const d = s.decision;
  const h = pf.holdings[s.ticker];
  const pnl = h && h.qty > 0 && h.avgPrice > 0 ? (s.price / h.avgPrice - 1) * 100 : null;
  const plan = d.plan.map((r) => (assumed && r.label === "수량" ? { ...r, hint: `${r.hint ? `${r.hint} · ` : ""}현금 1,000만원 기준` } : r));
  const hasMore = d.reasons.length > 0 || d.cautions.length > 0 || s.news.length > 0 || s.flows5 != null || (s.regime?.lines.length ?? 0) > 0;
  return (
    <div className="card">
      <div className="stock-head">
        <div>
          <div className="stock-name">{s.name}</div>
          <div className="stock-price">{won(s.price)}</div>
          <div className={`stock-chg ${cls(s.changePct)}`}>
            {s.change > 0 ? "▲" : s.change < 0 ? "▼" : ""} {Math.abs(Math.round(s.change)).toLocaleString("ko-KR")}원 ({sgn(s.changePct)})
          </div>
        </div>
        {s.today && (
          <div className="mini-range">
            시가 {Math.round(s.today.open).toLocaleString("ko-KR")}
            <br />
            고가 <span className="up">{Math.round(s.today.high).toLocaleString("ko-KR")}</span>
            <br />
            저가 <span className="down">{Math.round(s.today.low).toLocaleString("ko-KR")}</span>
          </div>
        )}
      </div>

      <div className={`verdict ${d.tone}`}>
        <div className="verdict-title">{d.title}</div>
        <div className="verdict-sum">{d.summary}</div>
        {plan.length > 0 && (
          <div className="plan">
            {plan.map((r) => (
              <div className="plan-row" key={r.label}>
                <span className="plan-label">{r.label}</span>
                <span className="plan-val">
                  {r.value}
                  {r.hint && <span className="plan-hint">{r.hint}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {d.timing && (
        <div className="timing">
          <span aria-hidden>💡</span>
          <span>{d.timing}</span>
        </div>
      )}

      {d.day && <ProbBar v={d.day} title="단타" />}
      {d.swing && <ProbBar v={d.swing} title="며칠" />}

      {s.regime && (
        <div className="regime">
          <div className="regime-head">
            <span className="label">지금 국면</span>
            <b>{s.regime.headline}</b>
          </div>
          {s.regime.edge && <div className={`regime-edge${s.regime.edge.better === true ? " good" : s.regime.edge.better === false ? " bad" : ""}`}>{s.regime.edge.text}</div>}
        </div>
      )}

      <div className="mypos">
        {h && h.qty > 0 ? (
          <span>
            보유 {h.qty.toLocaleString("ko-KR")}주 · 평단 {won(h.avgPrice)}
            {pnl != null && (
              <b className={cls(pnl)} style={{ marginLeft: 6 }}>
                {sgn(pnl, 1)}
              </b>
            )}
          </span>
        ) : (
          <span>보유하고 있지 않아요</span>
        )}
        <button onClick={onEdit}>{h && h.qty > 0 ? "수정" : "보유 입력"}</button>
      </div>

      {hasMore && (
        <div className="more">
          <button className="more-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span>왜 이렇게 판단했나요?</span>
            <Ico.chev />
          </button>
          {open && (
            <>
              <ul className="list">
                {d.cautions.map((c) => (
                  <li className="caution" key={c}>
                    {c}
                  </li>
                ))}
                {d.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
                {s.regime?.lines.map((l) => (
                  <li key={l.label}>
                    {l.label}: {l.value} — {l.detail}
                  </li>
                ))}
                {s.flows5 && (
                  <li>
                    최근 {s.flows5.days}일 외국인 {s.flows5.foreign >= 0 ? "순매수" : "순매도"} {Math.abs(s.flows5.foreign).toLocaleString("ko-KR")}주 · 기관{" "}
                    {s.flows5.inst >= 0 ? "순매수" : "순매도"} {Math.abs(s.flows5.inst).toLocaleString("ko-KR")}주
                  </li>
                )}
                {d.swing && s.prediction.swingReasons.length > 0 && <li>며칠 관점: {s.prediction.swingReasons.slice(0, 2).join(" · ")}</li>}
              </ul>
              {s.news.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="label">관련 뉴스</div>
                  {s.news.map((n) => (
                    <div className="news-item" key={n.title}>
                      <span className={`badge ${n.sentiment === "긍정" ? "pos" : n.sentiment === "부정" ? "neg" : "neu"}`}>
                        {n.isBreaking ? "속보" : n.sentiment === "긍정" ? "호재" : n.sentiment === "부정" ? "악재" : "중립"}
                      </span>
                      {n.title}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── 오늘 시황 ──────────────────────────────────────────────
function MarketCard({ m }: { m: QuickRes["market"] }) {
  const lines = m.regime ?? [];
  if (lines.length === 0) return null;
  return (
    <div className="card mkt">
      <div className="mkt-top">
        <span className="label">오늘 시황</span>
        {m.usdkrw && <span className="small">환율 {Math.round(m.usdkrw.price).toLocaleString("ko-KR")}원</span>}
      </div>
      {lines.map((l) => (
        <div className="mkt-row" key={l.label}>
          <span className="mkt-label">{l.label}</span>
          <span className="mkt-val">
            <b className={l.tone}>{l.value}</b>
            <small>{l.detail}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── AI 심층 분석 ────────────────────────────────────────────
const DEEP_STEPS = ["시황 읽는 중", "추세 보는 중", "수급 확인 중", "뉴스 해석 중", "결론·시나리오 정리 중"];
const STANCE_TXT: Record<DeepStock["stance"], string> = { up: "오르는 쪽", down: "내리는 쪽", neutral: "중립" };

function DeepStockView({ a }: { a: DeepStock }) {
  const rows: [string, string][] = [
    ["시황", a.market],
    ["추세", a.trend],
    ["수급", a.flow],
    ["뉴스", a.news],
  ];
  return (
    <div className="ai-stock">
      <div className="ai-headline">{a.headline}</div>
      <div className="ai-meta">
        <span className={`ai-stance ${a.stance}`}>AI 기울기 · {STANCE_TXT[a.stance]}</span>
        <span className="ai-conf">확신 {a.confidence}</span>
      </div>
      <div className="ai-rows">
        {rows.map(([k, v]) => (
          <div className="ai-row" key={k}>
            <span className="ai-k">{k}</span>
            <span className="ai-v">{v}</span>
          </div>
        ))}
      </div>
      <div className="ai-conclusion">
        <span className="ai-k">결론</span>
        <p>{a.conclusion}</p>
      </div>
      {a.scenarios.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 18 }}>
            이렇게 되면 이렇게
          </div>
          {a.scenarios.map((sc, i) => (
            <div className="sc" key={i}>
              <div className="sc-if">{sc.trigger}</div>
              <div className="sc-then">{sc.action}</div>
            </div>
          ))}
        </>
      )}
      {a.watch.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 16 }}>
            지금 지켜볼 것
          </div>
          <div className="ai-watch">
            {a.watch.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
        </>
      )}
      {a.risks.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 16 }}>
            틀릴 수 있는 이유
          </div>
          <ul className="list">
            {a.risks.map((r) => (
              <li className="caution" key={r}>
                {r}
              </li>
            ))}
          </ul>
        </>
      )}
      {a.guard && a.guard.length > 0 && <div className="ai-guard">점검: {a.guard.join(" · ")}</div>}
    </div>
  );
}

function DeepCard({
  deep,
  loading,
  err,
  onRun,
  now,
}: {
  deep: DeepAnalysis | null;
  loading: boolean;
  err: string | null;
  onRun: () => void;
  now: number;
}) {
  const [pick, setPick] = useState<StockKey>("005930");
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!loading) return;
    setStep(0);
    const id = setInterval(() => setStep((x) => Math.min(DEEP_STEPS.length - 1, x + 1)), 6000);
    return () => clearInterval(id);
  }, [loading]);
  const age = deep ? Math.max(0, Math.round((now - new Date(deep.generatedAt).getTime()) / 60_000)) : null;
  const cur = deep?.stocks.find((x) => x.ticker === pick) ?? deep?.stocks[0] ?? null;
  return (
    <div className="card ai-card">
      <div className="ai-top">
        <div>
          <div className="ai-title">AI 심층 분석</div>
          <div className="small">
            {deep && age != null ? `${deep.kstTime} 기준 · ${age === 0 ? "방금" : `${age}분 전`} 분석` : "시황 → 추세 → 수급 → 뉴스 → 결론, 가격별 대응까지"}
          </div>
        </div>
        {deep && !loading && (
          <button className="ai-again" onClick={onRun}>
            다시 분석
          </button>
        )}
      </div>

      {loading && (
        <div className="ai-steps">
          {DEEP_STEPS.map((t, i) => (
            <div key={t} className={`ai-step${i < step ? " done" : i === step ? " on" : ""}`}>
              <span className="ai-dot" />
              {t}
            </div>
          ))}
          <div className="small" style={{ marginTop: 8 }}>
            20~40초 걸려요. 화면을 닫지 마세요.
          </div>
        </div>
      )}

      {!loading && err && <div className="notice danger" style={{ marginTop: 14 }}>{err}</div>}

      {!loading && !deep && (
        <>
          <div className="ai-desc">
            위 판단에 쓴 숫자를 전부 AI에게 넘겨, 왜 그런지 단계별로 풀고 &quot;이 가격을 넘으면 / 깨지면 이렇게&quot; 대응을 세워 드려요. AI는 검증된
            결론을 뒤집지 못하고, AI가 기운 방향도 그날 종가로 따로 채점해요.
          </div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={onRun}>
            AI 심층 분석 받기
          </button>
        </>
      )}

      {!loading && deep && (
        <>
          <p className="ai-market">{deep.marketView}</p>
          <div className="seg" role="tablist">
            {KEYS.map((k) => (
              <button key={k} role="tab" aria-selected={pick === k} className={pick === k ? "on" : undefined} onClick={() => setPick(k)}>
                {NAMES[k]}
              </button>
            ))}
          </div>
          {cur && <DeepStockView a={cur} />}
          <div className="small" style={{ marginTop: 14 }}>
            사고팔 결론·수량·손절가는 위 종목 카드를 따르세요. AI 설명은 이해를 돕는 참고 자료예요.
          </div>
        </>
      )}
    </div>
  );
}

// ── 자산 입력 시트 ──────────────────────────────────────────
function EditSheet({
  pf,
  prices,
  onClose,
  onSave,
}: {
  pf: Portfolio;
  prices: Partial<Record<StockKey, number>>;
  onClose: () => void;
  onSave: (p: Portfolio) => void;
}) {
  const [cash, setCash] = useState(pf.known ? fmtInput(pf.cash) : "");
  const [rows, setRows] = useState(
    () =>
      Object.fromEntries(KEYS.map((k) => [k, { qty: fmtInput(pf.holdings[k]?.qty ?? 0), avg: fmtInput(pf.holdings[k]?.avgPrice ?? 0) }])) as Record<
        StockKey,
        { qty: string; avg: string }
      >,
  );
  const set = (k: StockKey, f: "qty" | "avg", v: string) => setRows((r) => ({ ...r, [k]: { ...r[k], [f]: fmtInput(digits(v)) } }));
  const bad = KEYS.find((k) => digits(rows[k].qty) > 0 && digits(rows[k].avg) <= 0);
  const save = () => {
    const holdings: Portfolio["holdings"] = {};
    for (const k of KEYS) {
      const q = digits(rows[k].qty);
      const a = digits(rows[k].avg);
      if (q > 0 && a > 0) holdings[k] = { qty: q, avgPrice: a };
    }
    onSave({ cash: digits(cash), holdings, known: true });
  };
  return (
    <>
      <div className="sheet-bg" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label="내 자산 입력">
        <div className="sheet-grip" />
        <h2>내 자산</h2>
        <div className="desc">이 기기에만 저장돼요. 몇 주를 살지 계산하는 데만 써요.</div>

        <div className="field">
          <div className="field-label">
            주문 가능 현금 <small>{digits(cash) > 0 ? manwon(digits(cash)) : ""}</small>
          </div>
          <input className="num-input" inputMode="numeric" placeholder="0원" value={cash} onChange={(e) => setCash(fmtInput(digits(e.target.value)))} />
          <div className="quick">
            {[1_000_000, 5_000_000, 10_000_000].map((v) => (
              <button key={v} onClick={() => setCash(fmtInput(digits(cash) + v))}>
                +{manwon(v)}
              </button>
            ))}
            <button onClick={() => setCash("")}>지우기</button>
          </div>
        </div>

        {KEYS.map((k) => (
          <div className="stock-block" key={k}>
            <div className="stock-block-name">
              {NAMES[k]} {prices[k] ? <span className="small">· 지금 {won(prices[k])}</span> : null}
            </div>
            <div className="two" style={{ marginTop: 10 }}>
              <div>
                <div className="field-label">보유 수량</div>
                <input className="num-input" inputMode="numeric" placeholder="0주" value={rows[k].qty} onChange={(e) => set(k, "qty", e.target.value)} />
              </div>
              <div>
                <div className="field-label">평균 단가</div>
                <input className="num-input" inputMode="numeric" placeholder="0원" value={rows[k].avg} onChange={(e) => set(k, "avg", e.target.value)} />
              </div>
            </div>
          </div>
        ))}
        {bad && <div className="err">{NAMES[bad]}의 평균 단가를 넣어 주세요 (수익률·손절가 계산에 필요해요)</div>}
        <button className="btn btn-primary" disabled={Boolean(bad)} onClick={save}>
          저장하고 다시 판단받기
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          닫기
        </button>
      </div>
    </>
  );
}

// ── 성적표 탭 ──────────────────────────────────────────────
function LogRows({ rows }: { rows: LogEntry[] }) {
  return (
    <div style={{ marginTop: 12 }}>
      {rows
        .slice(-8)
        .reverse()
        .map((e) => {
          const base = e.result ? e.result : null;
          return (
            <div className="trust-row" key={e.id}>
              <span>
                {e.date.slice(5)} {e.atOpen ? "장전" : e.time} {NAMES[e.ticker]} · {e.dir === 1 ? "오른다" : "밀린다"}
                {e.src !== "ai" && ` (${Math.round(e.prob * 100)}%)`}
              </span>
              <span className={base ? (base.hit ? "up" : "down") : "flat"}>
                {base ? `${base.hit ? "적중" : "빗나감"} ${sgn((base.close / (base.base ?? e.price) - 1) * 100, 1)}` : "채점 대기"}
              </span>
            </div>
          );
        })}
    </div>
  );
}

function TrustTab({ data, log }: { data: QuickRes | null; log: LogEntry[] }) {
  const modelLog = log.filter((e) => e.src !== "ai");
  const aiLog = log.filter((e) => e.src === "ai");
  const graded = modelLog.filter((e) => e.result);
  const hits = graded.filter((e) => e.result!.hit).length;
  const aiGraded = aiLog.filter((e) => e.result);
  const aiHits = aiGraded.filter((e) => e.result!.hit).length;
  const m = data?.model;
  return (
    <>
      <div className="sec-title">이 판단은 얼마나 맞았나요?</div>
      <div className="card">
        <div className="label">단타 신호 적중률 (과거 검증)</div>
        <div className="trust-big">{m?.dayHit ? `${m.dayHit.hitPct}%` : "-"}</div>
        <div className="small" style={{ marginTop: 4 }}>
          &quot;오를 가능성 높음(55% 이상)&quot;·&quot;밀릴 가능성 높음(45% 이하)&quot;이라고 했던 {m?.dayHit?.n.toLocaleString("ko-KR") ?? "-"}번 중 실제로 그
          방향이었던 비율이에요. 같은 날들에 근거 없이 찍었다면 {m?.dayHit?.naivePct ?? "-"}%가 맞았어요(장중엔 밀리는 날이 조금 더 많아서 50%가 아니에요).
        </div>
        <div style={{ marginTop: 14 }}>
          <div className="trust-row">
            <span>검증 기간</span>
            <span>{m?.dayPeriod ?? "-"}</span>
          </div>
          <div className="trust-row">
            <span>검증 방식</span>
            <span>그 이전 데이터로만 배우고 이후에 적용</span>
          </div>
          {m?.openByYear && (
            <div className="trust-row">
              <span>해마다 기준선을 넘었나</span>
              <span>
                {m.openByYear.filter((y) => y.auc > 0.5).length}/{m.openByYear.length}년
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="label">이 기기에서 받은 신호</div>
        {graded.length > 0 ? (
          <>
            <div className="trust-big">
              {graded.length}번 중 {hits}번 적중
            </div>
            <div className="small" style={{ marginTop: 4 }}>
              당일 종가로 채점해요. 표본이 30번은 넘어야 운과 실력을 구분할 수 있어요.
            </div>
          </>
        ) : (
          <div className="small" style={{ marginTop: 6 }}>
            아직 채점된 신호가 없어요. &quot;지금 사세요&quot;·&quot;밀릴 가능성 높음&quot; 같은 신호를 받으면 그날 종가로 자동 채점됩니다.
          </div>
        )}
        {modelLog.length > 0 && <LogRows rows={modelLog} />}
      </div>

      <div className="card">
        <div className="label">AI 심층 분석의 방향은?</div>
        {aiGraded.length > 0 ? (
          <>
            <div className="trust-big">
              {aiGraded.length}번 중 {aiHits}번 적중
            </div>
            <div className="small" style={{ marginTop: 4 }}>
              AI가 &quot;오르는 쪽&quot;·&quot;내리는 쪽&quot;으로 기운 날을 그날 종가로 채점해요(중립은 채점하지 않아요). 앱 신호보다 낫지 않으면 AI 설명은
              참고로만 보세요.
            </div>
          </>
        ) : (
          <div className="small" style={{ marginTop: 6 }}>
            아직 채점된 AI 판단이 없어요. 장중이나 장 시작 전에 &quot;AI 심층 분석&quot;을 받으면 AI가 기운 방향을 그날 종가로 채점해요.
          </div>
        )}
        {aiLog.length > 0 && <LogRows rows={aiLog} />}
      </div>

      {m?.byRegime && m.byRegime.length > 0 && (
        <div className="card">
          <div className="label">어떤 장에서 잘 맞았나 (장 시작 판단, 과거 검증)</div>
          <div style={{ marginTop: 8 }}>
            {m.byRegime
              .filter((r) => r.hit && r.hit.n >= 30)
              .map((r) => (
                <div className="trust-row" key={r.key}>
                  <span>{r.label}</span>
                  <span>
                    <b className={r.hit!.hitPct - r.hit!.naivePct >= 8 ? "up" : undefined}>{r.hit!.hitPct}%</b>
                    <span className="small"> 적중 · 찍기 {r.hit!.naivePct}% · {r.hit!.n.toLocaleString("ko-KR")}번</span>
                  </span>
                </div>
              ))}
          </div>
          <div className="small" style={{ marginTop: 8 }}>
            변동성은 최근 20일 흔들림을 최근 반년 평균과 비교해요. 추세는 20일 이동평균보다 얼마나 위·아래인지로 나눠요. 지금 국면은 종목 카드의 &quot;지금 국면&quot;에
            나와요.
          </div>
        </div>
      )}

      <div className="card">
        <div className="label">며칠 뒤 예측은?</div>
        <div style={{ fontSize: 17, fontWeight: 700, marginTop: 4 }}>아직 근거가 약해요</div>
        <div className="small" style={{ marginTop: 4 }}>
          {m?.swingDays ?? 3}거래일 뒤 방향은 과거 검증에서 동전 던지기보다 조금 나은 수준(구분력 {m ? (m.swingAuc * 100).toFixed(1) : "-"}점, 50점이 동전)이라
          &quot;참고용&quot;으로만 보여 드리고 사라·팔라 판단에는 쓰지 않아요.
        </div>
      </div>
      <div className="small" style={{ padding: "0 6px" }}>
        데이터: 일봉 {m?.dataRange.daily ?? "-"} · 1시간봉 {m?.dataRange.hourly ?? "-"} · 외국인·기관 {m?.dataRange.flows ?? "-"}. 매주 일요일 새 데이터로 다시 학습해요.
        과거 성적이 미래 수익을 보장하지 않습니다.
      </div>
    </>
  );
}

// ── 도움말 탭 ──────────────────────────────────────────────
function HelpTab() {
  const qa: [string, string][] = [
    ["이 앱은 뭘 해 주나요?", "삼성전자와 SK하이닉스 두 종목만 봅니다. 지금 사야 할지, 기다릴지, 팔지를 한 줄로 알려 주고, 산다면 얼마에 몇 주를 사고 어디서 자를지 숫자로 알려 드려요."],
    ["\"단타\" 확률은 뭔가요?", "지금 사서 오늘 장 마감 때까지 가지고 있으면 오를 확률이에요. 10년치 일봉과 3년치 1시간봉으로 배운 모델이 계산하고, 과거 비슷한 상황(같은 국면이면 같은 국면)의 실제 결과를 함께 보여 드려요."],
    ["언제 \"지금 사세요\"가 나오나요?", "오전(장 시작 전~12시)에 단타 확률이 55% 이상일 때만이에요. 오후 신호는 맞더라도 남은 상승폭이 거래비용(약 0.18%)보다 작았어서 사라고 하지 않아요."],
    ["무엇을 보고 판단하나요?", "간밤 엔비디아·미국 반도체지수·마이크론, 오늘 시가가 얼마나 떴는지, 어제 어디서 마감했는지, 최근 5일과 한 달 흐름, 장중에는 시가 대비 위치와 오늘 고가·저가 사이 위치예요. 예: 간밤 미국 반도체가 크게 오른 날은 시가가 높게 뜬 뒤 장중에 밀린 경우가 많았어요. 반대로 마이크론이 오른 날과 한 달 추세가 오르는 중일 때는 유리했어요."],
    ["\"지금 국면\"은 뭔가요?", "추세(20일 평균보다 위·아래)와 변동성(요즘 흔들림이 최근 반년보다 큰지)으로 지금 어떤 장인지 나눈 거예요. 같은 신호도 국면마다 맞힌 정도가 달랐어요 — 변동이 큰 장에서 가장 잘 맞았어요. 덜 맞았던 국면에서는 수량을 30% 줄여서 알려 드려요."],
    ["AI 심층 분석은 뭔가요?", "버튼을 누르면 앱이 쓴 숫자(확률·국면·가격대·수급·뉴스)를 전부 AI에게 넘겨 시황 → 추세 → 수급 → 뉴스 → 결론 순서로 풀어 주고, '이 가격을 넘으면 / 깨지면 이렇게' 대응을 세워 드려요. AI는 검증된 결론을 뒤집지 못하게 막아 두었고, AI가 기운 방향도 그날 종가로 채점해서 성적표에 보여 드려요."],
    ["나스닥 선물·환율·수급은 왜 확률에 안 들어가요?", "넣어 보고 과거 데이터로 검증했지만 맞히는 데 도움이 되지 않았어요. 그래서 확률 계산에서는 빼고, 시황 카드와 AI 분석의 설명 자료로만 써요."],
    ["\"며칠\" 확률은 왜 회색인가요?", "3거래일 뒤 방향은 검증에서 거의 맞히지 못했어요. 그래서 참고로만 보여 드리고 사라·팔라는 결론에는 쓰지 않아요."],
    ["손절가는 꼭 지켜야 하나요?", "네. 이 앱의 확률은 50%를 조금 넘는 수준이라 틀리는 날도 많아요. 수익을 지켜 주는 건 손절가와 \"한 번에 총자산 1% 이상 잃지 않는\" 수량이에요."],
    ["내 정보는 어디에 저장되나요?", "현금·보유 수량은 이 기기(브라우저)에만 저장되고, 판단을 계산할 때만 서버로 보내요. 서버에는 남지 않아요."],
    ["주문도 대신 해 주나요?", "아니요. 판단만 알려 드려요. 실제 주문은 증권사 앱에서 직접 해 주세요. 시세가 몇 분 늦을 수 있으니 주문 전 증권사 앱 가격을 꼭 확인하세요."],
  ];
  return (
    <>
      <div className="sec-title">도움말</div>
      <div className="card">
        {qa.map(([q, a], i) => (
          <div key={q} style={i === 0 ? { marginTop: -18 } : undefined}>
            <div className="faq-q">{q}</div>
            <div className="faq-a">{a}</div>
          </div>
        ))}
      </div>
      <div className="small" style={{ padding: "0 6px" }}>
        투자 참고 정보이며 수익을 보장하지 않습니다. 모든 투자의 최종 판단과 책임은 본인에게 있습니다.
      </div>
    </>
  );
}

// ── 메인 ───────────────────────────────────────────────────
export default function Home() {
  const [pf, setPf] = useState<Portfolio>({ cash: 0, holdings: {}, known: false });
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<QuickRes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<"home" | "trust" | "help">("home");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [now, setNow] = useState(Date.now());
  const [deep, setDeep] = useState<DeepAnalysis | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepErr, setDeepErr] = useState<string | null>(null);
  const inflight = useRef(false);

  useEffect(() => {
    setPf(loadPortfolio());
    setLog(loadJSON<LogEntry[]>(LOG_KEY, []));
    // 직전 AI 분석은 같은 날 6시간 안이면 다시 보여 준다
    const saved = loadJSON<DeepAnalysis | null>(DEEP_KEY, null);
    if (saved?.generatedAt && kstDate(new Date(saved.generatedAt)) === kstDate() && Date.now() - new Date(saved.generatedAt).getTime() < 6 * 3600_000) setDeep(saved);
    setReady(true);
  }, []);

  const bodyOf = (p: Portfolio) => ({
    portfolio: {
      cash: p.known ? p.cash : DEFAULT_CASH,
      holdings: KEYS.flatMap((k) => (p.holdings[k] ? [{ ticker: k, ...p.holdings[k] }] : [])),
    },
  });

  const fetchQuick = useCallback(async (p: Portfolio) => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const res = await fetch("/api/quick", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyOf(p)) });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const j = (await res.json()) as QuickRes;
      if (!res.ok || j.error) throw new Error(j.error ?? `오류 ${res.status}`);
      setData(j);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "연결에 실패했어요");
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, []);

  // AI 심층 분석 — 버튼을 눌렀을 때만 (비용·시간이 드는 호출)
  const runDeep = useCallback(async () => {
    if (deepLoading) return;
    setDeepLoading(true);
    setDeepErr(null);
    try {
      const res = await fetch("/api/deep", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...bodyOf(pf), force: deep != null }) });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const j = (await res.json().catch(() => ({ error: `오류 ${res.status} — 잠시 후 다시 눌러 주세요` }))) as { analysis?: DeepAnalysis | null; error?: string | null; quick?: QuickRes };
      if (j.quick && !j.quick.error) setData(j.quick);
      if (!j.analysis) throw new Error(j.error ?? `오류 ${res.status}`);
      setDeep(j.analysis);
      saveJSON(DEEP_KEY, j.analysis);
      // AI가 기운 방향 기록 (장전·장중만, 중립 제외, 종목별 하루 한 번)
      const today = kstDate();
      setLog((prev) => {
        const next = [...prev];
        for (const a of j.analysis!.stocks) {
          const dir = a.stance === "up" ? 1 : a.stance === "down" ? -1 : 0;
          const pre = a.at?.checkpoint === "pre";
          if (!dir || !a.at || !(a.at.inSession || pre)) continue;
          const id = `${a.ticker}-${today}-ai`;
          if (next.some((e) => e.id === id)) continue;
          next.push({ id, ticker: a.ticker, date: today, time: kstHM(), price: a.at.price, dir, prob: a.at.dayProb ?? 0.5, src: "ai", atOpen: pre });
        }
        const trimmed = next.slice(-200);
        saveJSON(LOG_KEY, trimmed);
        return trimmed;
      });
    } catch (e) {
      setDeepErr(e instanceof Error ? e.message : "AI 분석에 실패했어요");
    } finally {
      setDeepLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pf, deep, deepLoading]);

  // 처음 열 때 + 자산이 바뀔 때
  useEffect(() => {
    if (ready) fetchQuick(pf);
  }, [ready, pf, fetchQuick]);

  // 자동 갱신: 장중 1분, 그 외 10분. 화면이 가려져 있으면 쉬고, 다시 보이면 바로 갱신
  const inSession = data ? ["장초반", "장중", "점심시간대", "마감임박", "동시호가"].includes(data.phase.phase) : false;
  const updatedAt = data?.updatedAt;
  useEffect(() => {
    if (!ready) return;
    const ms = inSession ? 60_000 : 600_000;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fetchQuick(pf);
    }, ms);
    const onVis = () => {
      if (document.visibilityState === "visible" && updatedAt && Date.now() - new Date(updatedAt).getTime() > 60_000) fetchQuick(pf);
    };
    document.addEventListener("visibilitychange", onVis);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      clearInterval(id);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ready, inSession, pf, updatedAt, fetchQuick]);

  // 신호 기록 + 채점 (이 기기 전용 성적표)
  useEffect(() => {
    if (!data) return;
    const today = kstDate();
    setLog((prev) => {
      let changed = false;
      const next = prev.map((e) => ({ ...e }));
      for (const s of data.stocks) {
        if (s.error) continue;
        const c = s.decision.claim;
        if (c.horizon === "day" && c.dir !== 0 && c.prob != null && data.phase.phase !== "장마감") {
          const id = `${s.ticker}-${today}-${c.dir}`;
          if (!next.some((e) => e.id === id)) {
            next.push({ id, ticker: s.ticker, date: today, time: kstHM(), price: s.price, dir: c.dir, prob: c.prob, src: "model", atOpen: data.phase.phase === "장전" });
            changed = true;
          }
        }
        for (const e of next) {
          if (e.ticker !== s.ticker || e.result) continue;
          const bar = s.recentCloses.find((x) => x.d === e.date);
          const afterClose = e.date < today || data.phase.phase === "장마감";
          // 장전 신호는 "시가에 사서 종가까지"로 채점 — 시가를 모르는 예전 응답이면 기록 시점 가격으로
          const base = e.atOpen && bar?.o ? bar.o : e.price;
          if (bar?.c && afterClose) {
            e.result = { close: bar.c, hit: (bar.c - base) * e.dir > 0, base };
            changed = true;
          }
        }
      }
      if (!changed) return prev;
      const trimmed = next.slice(-200);
      saveJSON(LOG_KEY, trimmed);
      return trimmed;
    });
  }, [data]);

  const savePf = (p: Portfolio) => {
    setPf(p);
    persistPortfolio(p);
    setEditing(false);
  };

  const ageMin = data ? Math.max(0, Math.round((now - new Date(data.updatedAt).getTime()) / 60_000)) : null;
  const prices = useMemo(
    () => Object.fromEntries((data?.stocks ?? []).filter((s) => !s.error).map((s) => [s.ticker, s.price])) as Partial<Record<StockKey, number>>,
    [data],
  );
  const holdingsValue = KEYS.reduce((a, k) => a + (pf.holdings[k]?.qty ?? 0) * (prices[k] ?? pf.holdings[k]?.avgPrice ?? 0), 0);
  const m = data?.market;

  return (
    <main className="wrap">
      <header className="top">
        <h1>내 주식 비서</h1>
        <div className="top-right">
          <span className="pill">
            <span className={`dot${inSession ? " on" : ""}`} />
            {data ? `${data.phase.phase} ${data.phase.kstTime}` : "불러오는 중"}
          </span>
          <button className="icon-btn" aria-label="새로고침" onClick={() => fetchQuick(pf)}>
            <Ico.refresh spin={loading} />
          </button>
        </div>
      </header>

      {tab === "home" && (
        <>
          {m && <MarketCard m={m} />}
          {m && !m.regime?.length && (
            <div className="strip">
              {m.kospi && (
                <span className="chip">
                  코스피<b className={cls(m.kospi.changePct)}>{sgn(m.kospi.changePct)}</b>
                </span>
              )}
              {m.sox && (
                <span className="chip">
                  간밤 미국 반도체<b className={cls(m.sox.changePct)}>{sgn(m.sox.changePct)}</b>
                </span>
              )}
            </div>
          )}

          <button className="card card-tap acct" onClick={() => setEditing(true)}>
            <div>
              <div className="label">{pf.known ? "내 자산" : "내 자산을 넣으면 몇 주 살지 계산해 드려요"}</div>
              {pf.known ? (
                <>
                  <div className="acct-total">{won(pf.cash + holdingsValue)}</div>
                  <div className="acct-sub">
                    현금 {won(pf.cash)}
                    {data && data.account.todayPnlWon !== 0 && (
                      <>
                        {" · 오늘 "}
                        <b className={cls(data.account.todayPnlWon)}>
                          {data.account.todayPnlWon > 0 ? "+" : ""}
                          {Math.round(data.account.todayPnlWon).toLocaleString("ko-KR")}원
                        </b>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="acct-sub">지금은 현금 1,000만원 기준으로 보여 드려요</div>
              )}
            </div>
            <span className="acct-edit">{pf.known ? "수정" : "입력하기"}</span>
          </button>

          {data?.account.dailyStop && <div className="notice danger">오늘 계좌 손실이 -3%에 닿았어요. 오늘은 새로 사지 않는 날이에요.</div>}
          {data && !data.account.dailyStop && data.account.dailyWarn && (
            <div className="notice warn">오늘 계좌가 {sgn(data.account.todayPnlPct, 1)}예요. -3%가 되면 그날은 매수를 멈춰요.</div>
          )}
          {err && <div className="notice danger">{err} — 오른쪽 위 새로고침을 눌러 주세요.</div>}
          {data && ageMin != null && ageMin >= 5 && !loading && (
            <div className="notice info">{ageMin}분 전 판단이에요. 새로고침하면 지금 기준으로 다시 계산해요.</div>
          )}

          {!data &&
            !err &&
            KEYS.map((k) => (
              <div className="card" key={k}>
                <div className="skel" style={{ width: 90, height: 18 }} />
                <div className="skel" style={{ width: 160, height: 30, marginTop: 8 }} />
                <div className="skel" style={{ height: 92, marginTop: 16, borderRadius: 18 }} />
                <div className="skel" style={{ height: 40, marginTop: 16 }} />
              </div>
            ))}

          {data?.stocks.map((s) => <StockCard key={s.ticker} s={s} pf={pf} onEdit={() => setEditing(true)} assumed={!pf.known} />)}

          {data && <DeepCard deep={deep} loading={deepLoading} err={deepErr} onRun={runDeep} now={now} />}

          {data && (
            <div className="small" style={{ padding: "4px 6px" }}>
              {ageMin === 0 ? "방금" : `${ageMin}분 전`} 업데이트 · 장중에는 1분마다 저절로 바뀌어요. 시세는 몇 분 늦을 수 있으니 주문 전 증권사 앱 가격을 확인하세요.
            </div>
          )}
        </>
      )}

      {tab === "trust" && <TrustTab data={data} log={log} />}
      {tab === "help" && <HelpTab />}

      {editing && <EditSheet pf={pf} prices={prices} onClose={() => setEditing(false)} onSave={savePf} />}

      <nav className="tabbar">
        <div className="tabbar-in">
          <button className={`tab${tab === "home" ? " on" : ""}`} onClick={() => setTab("home")}>
            <Ico.home />
            지금 할 일
          </button>
          <button className={`tab${tab === "trust" ? " on" : ""}`} onClick={() => setTab("trust")}>
            <Ico.chart />
            성적표
          </button>
          <button className={`tab${tab === "help" ? " on" : ""}`} onClick={() => setTab("help")}>
            <Ico.help />
            도움말
          </button>
        </div>
      </nav>
    </main>
  );
}
