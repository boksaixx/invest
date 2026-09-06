"use client";

// 비서 화면 요소 — 브리핑 카드, 하단 고정 행동 바, 첫 사용 안내.
// 데이터 계산은 lib/briefing.ts(순수 함수)가 하고, 여기는 그리기만 한다.
import type { Briefing } from "@/lib/briefing";

const MOOD_LABEL: Record<Briefing["mood"], string> = { calm: "차분", alert: "주의", danger: "위험" };

export function SecretaryCard({
  briefing,
  onAlertTap,
}: {
  briefing: Briefing;
  onAlertTap?: (ticker: string) => void;
}) {
  return (
    <section className={`sec-card mood-${briefing.mood}`} aria-label="비서 브리핑">
      <div className="sec-head">
        <div className="sec-avatar" aria-hidden>
          <span>비</span>
        </div>
        <div className="sec-head-text">
          <div className="sec-greet">{briefing.greeting}</div>
          <div className="sec-when">{briefing.when}</div>
        </div>
        <span className={`sec-mood sec-mood-${briefing.mood}`}>{MOOD_LABEL[briefing.mood]}</span>
      </div>
      <h2 className="sec-headline">{briefing.headline}</h2>
      {briefing.lines.length > 0 && (
        <p className="sec-lines">
          {briefing.lines.map((l, i) => (
            <span key={i}>{l} </span>
          ))}
        </p>
      )}
      {briefing.alerts.length > 0 && (
        <ul className="sec-alerts">
          {briefing.alerts.map((a, i) => (
            <li
              key={i}
              className={`sec-alert sec-alert-${a.level}${a.ticker ? " tappable" : ""}`}
              onClick={a.ticker && onAlertTap ? () => onAlertTap(a.ticker!) : undefined}
              role={a.ticker ? "button" : undefined}
            >
              <span className="sec-alert-icon" aria-hidden>{a.icon}</span>
              <span className="sec-alert-body">
                <span className="sec-alert-text">{a.text}</span>
                {a.sub && <span className="sec-alert-sub">{a.sub}</span>}
              </span>
              {a.ticker && <span className="sec-alert-go" aria-hidden>›</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ActionBar({
  loading,
  elapsed,
  hasResult,
  staleText,
  costText,
  onAnalyze,
}: {
  loading: boolean;
  elapsed: number;
  hasResult: boolean;
  staleText: string | null;
  costText: string | null;
  onAnalyze: () => void;
}) {
  return (
    <div className="actionbar" role="region" aria-label="분석 실행">
      <div className="actionbar-meta">
        {loading ? (
          <span>비서가 시세·뉴스·공시를 읽는 중… {elapsed}초</span>
        ) : hasResult ? (
          <span>{staleText ?? "분석 완료"}{costText ? ` · ${costText}` : ""}</span>
        ) : (
          <span>보통 30초~2분 걸려요</span>
        )}
      </div>
      <button className="btn btn-primary actionbar-btn" onClick={onAnalyze} disabled={loading}>
        {loading ? (
          <>
            <span className="spinner" />
            분석 중
          </>
        ) : hasResult ? (
          "다시 브리핑 받기"
        ) : (
          "지금 브리핑 받기"
        )}
      </button>
    </div>
  );
}

export function Onboarding({ onOpenAssets, onAnalyze, loading }: { onOpenAssets: () => void; onAnalyze: () => void; loading: boolean }) {
  return (
    <section className="onboard" aria-label="처음 사용 안내">
      <div className="onboard-title">처음이시군요. 이렇게 시작해요</div>
      <ol className="onboard-steps">
        <li>
          <button className="onboard-step" onClick={onOpenAssets}>
            <span className="onboard-num">1</span>
            <span>
              <b>내 자산 입력</b>
              <small>현금과 보유 종목(평단가·수량)만 넣으면 됩니다 — 이 폰에만 저장돼요</small>
            </span>
            <span className="onboard-go">›</span>
          </button>
        </li>
        <li>
          <button className="onboard-step" onClick={onAnalyze} disabled={loading}>
            <span className="onboard-num">2</span>
            <span>
              <b>브리핑 받기</b>
              <small>비서가 시세·뉴스·공시를 읽고 종목마다 &quot;얼마에·얼마나·어디서 자를지&quot;를 말해줘요</small>
            </span>
            <span className="onboard-go">›</span>
          </button>
        </li>
      </ol>
      <div className="onboard-note">방향을 맞히는 앱이 아니에요. 손절선과 분할 청산으로 손실을 작게 만드는 비서예요.</div>
    </section>
  );
}
