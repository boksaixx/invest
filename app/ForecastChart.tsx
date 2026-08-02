"use client";

// 예상 경로 팬 차트 — "지금 조회한 시점부터 마감까지, 그리고 내일·모레"를 확률 구간으로 그린다.
//
// 왜 필요한가: "예상 등락 -11.7% ~ +14.2%" 같은 문장은 초보자가 감을 잡기 어렵다. 시간이
// 갈수록 불확실성이 어떻게 벌어지는지를 눈으로 보면 "손절선이 하루 변동폭 안에 있구나",
// "내일까지 보면 이만큼 벌어지는구나" 같은 판단이 바로 선다.
//
// 데이터는 lib/forecastPath.ts 가 계산하며, 폭은 검증된 변동성 모델에서 나온다
// (D+1/D+2/D+3 90% 구간 실제 적중률 88.3~89.4%, scripts/validate-forecast-path.ts).
//
// 표시상의 정직성:
//  - 가로축은 "시간 비례"가 아니라 오늘 남은 구간 1칸 + 이후 각 거래일 1칸씩의 균등 배분이다.
//    시간 비례로 그리면 장 후반에 조회했을 때 남은 장중 구간이 몇 분뿐이라 아예 보이지 않는다.
//    대신 축 라벨에 실제 시각을 적고 캡션에 이 사실을 명시한다.
//  - 중앙선은 예측이 아니라 "제자리 + 과거 같은 국면의 아주 약한 평균 흐름"이다.
//  - 눈금 글자는 SVG 밖 DOM으로 그린다. SVG는 가로폭에 맞춰 비율대로 늘어나는데, 글자까지
//    같이 늘어나면 화면 크기마다 글자 크기가 달라져 읽기 나빠진다.
import type { ForecastPathData } from "@/lib/types";
import { TOUCH_SAMPLE_SIZE } from "@/lib/touchProb";

type Props = {
  path: ForecastPathData;
  currency: "KRW" | "USD";
  /** 손절가·목표가를 같은 축에 겹쳐 그리면 "손절선이 하루 변동폭 안"인지 한눈에 보인다 */
  stopPrice?: number | null;
  targetPrice?: number | null;
  /**
   * 엔진의 현재 판단. 매도·손절을 권하는 종목에 "이 값에 사면"을 크게 띄우면
   * 사용자가 정반대로 행동할 수 있으므로, 그런 경우 매수 지정가를 숨긴다.
   */
  action?: string | null;
};

const W = 320;
const H = 170;
const PAD_L = 4;
const PAD_R = 50; // 오른쪽 가격 눈금 자리
const PAD_T = 10;
const PAD_B = 26; // 아래 시각 라벨 자리
const LABEL_HALF = 17; // 축 라벨 한 개의 대략적인 반폭 (viewBox 단위 ≒ px)
const LABEL_PAD = 4; // 라벨 사이 최소 여백
// 오늘 남은 구간에 주는 가로 비중. 이 차트의 주된 질문이 "지금부터 마감까지"라서
// 다음 거래일들보다 넓게 준다(장중 지점이 없는 상태에서는 의미가 없어 1로 되돌린다).
const TODAY_WEIGHT = 1.5;

function fmtPrice(v: number, currency: "KRW" | "USD"): string {
  return currency === "USD" ? `$${v.toFixed(2)}` : Math.round(v).toLocaleString();
}
/** 눈금용 짧은 표기 — 세로 눈금 자리가 좁아 원화는 천 단위로 줄인다 */
function fmtTick(v: number, currency: "KRW" | "USD"): string {
  if (currency === "USD") return `$${v.toFixed(0)}`;
  return v >= 10000 ? `${(v / 1000).toFixed(0)}천` : Math.round(v).toLocaleString();
}
/** 좁은 화면에서 축 라벨이 겹치지 않도록 줄인다 (읽어낼 값은 아래 요약에 온전히 적는다) */
const AXIS_SHORT: Record<string, string> = {
  "다음 거래일": "+1일",
  "2거래일 뒤": "+2일",
  "3거래일 뒤": "+3일",
  "15:30 마감": "15:30",
  "장 시작 전": "장전",
  "장 마감 기준": "종가",
  "휴장 중 · 직전 종가 기준": "종가",
  "현재 기준": "현재",
};
function shortLabel(label: string): string {
  return AXIS_SHORT[label] ?? label.replace(" 기준", "");
}

export default function ForecastChart({ path, currency, stopPrice, targetPrice, action }: Props) {
  // 엔진이 정리(매도·손절)를 권하는 중이면 매수 지정가를 제시하지 않는다.
  // "지금 팔아라"와 "이 값에 사라"를 나란히 보여주는 것은 사용자를 혼란에 빠뜨리는 것을 넘어
  // 실제 손실로 이어질 수 있다.
  const sellingMode = action === "손절" || action === "전량매도" || action === "부분매도";
  if (!path.available || path.points.length === 0) return null;

  // 왼쪽 끝은 "지금" — 불확실성 0에서 출발하므로 모든 구간이 현재가 한 점으로 모인다
  const now = {
    label: path.asOfLabel,
    median: path.currentPrice,
    p05: path.currentPrice,
    p25: path.currentPrice,
    p75: path.currentPrice,
    p95: path.currentPrice,
    isDayBoundary: false,
  };
  const pts = [now, ...path.points];

  let yMin = Math.min(...pts.map((p) => p.p05));
  let yMax = Math.max(...pts.map((p) => p.p95));
  // 손절가·목표가가 구간 밖이면 축을 넓혀 함께 보이게 한다 (밖에 있다는 사실 자체가 정보)
  for (const line of [stopPrice, targetPrice]) {
    if (line != null && line > 0) {
      yMin = Math.min(yMin, line);
      yMax = Math.max(yMax, line);
    }
  }
  if (!(yMax > yMin)) {
    yMin = path.currentPrice * 0.95;
    yMax = path.currentPrice * 1.05;
  }
  const pad = (yMax - yMin) * 0.06;
  yMin -= pad;
  yMax += pad;

  // 가로 배분: "오늘 남은 구간" 전체를 한 칸, 그 뒤 각 거래일을 한 칸씩 가져간다.
  // 지점 개수로 등분하면 30분 지점이 10개 넘게 쌓이는 아침에는 오늘이 가로를 다 먹고
  // 다음 거래일 라벨이 오른쪽 끝에 뭉쳐 읽을 수 없게 된다. 시간 비례로 그리면 반대로
  // 오후에 오늘 구간이 사라진다. 구간별 균등 배분이 두 문제를 동시에 피한다.
  const firstBoundary = Math.max(1, pts.findIndex((p) => p.isDayBoundary));
  const todayWeight = firstBoundary > 1 ? TODAY_WEIGHT : 1;
  const units: number[] = [0];
  for (let i = 1; i < pts.length; i++) units.push(units[i - 1] + (i <= firstBoundary ? todayWeight / firstBoundary : 1));
  const totalUnits = units[units.length - 1] || 1;

  const x = (i: number) => PAD_L + (units[i] / totalUnits) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + ((yMax - v) / (yMax - yMin)) * (H - PAD_T - PAD_B);
  const pctX = (i: number) => (x(i) / W) * 100;
  const pctY = (v: number) => (y(v) / H) * 100;

  // 위쪽 경계를 왼→오른쪽으로 그린 뒤 아래쪽 경계를 오른→왼쪽으로 되돌아와 닫는다
  const band = (lo: (p: (typeof pts)[number]) => number, hi: (p: (typeof pts)[number]) => number) => {
    const top = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(hi(p)).toFixed(1)}`);
    const bottom = [];
    for (let i = pts.length - 1; i >= 0; i--) bottom.push(`L${x(i).toFixed(1)},${y(lo(pts[i])).toFixed(1)}`);
    return `${top.join(" ")} ${bottom.join(" ")} Z`;
  };

  const medianPath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.median).toFixed(1)}`).join(" ");

  // 라벨 솎아내기 — 시작점과 거래일 경계는 반드시 표시하고, 그 사이 30분 지점은
  // 앞뒤로 최소 간격이 확보될 때만 끼워 넣는다(개수가 아니라 실제 거리 기준이라 어떤 시각에
  // 조회해도 글자가 겹치지 않는다).
  // 첫 라벨만 왼쪽 정렬(잘리지 않게)이라 오른쪽으로 한 칸 통째로 뻗는다 — 폭 계산에 반영한다.
  const mustLabel = new Set<number>([0, ...pts.map((p, i) => (p.isDayBoundary ? i : -1)).filter((i) => i >= 0)]);
  const mustSorted = [...mustLabel].sort((a, b) => a - b);
  const leftEdge = (i: number) => (i === 0 ? x(i) : x(i) - LABEL_HALF);
  const rightEdge = (i: number) => (i === 0 ? x(i) + LABEL_HALF * 2 : x(i) + LABEL_HALF);
  const labelIdx = new Set<number>();
  let lastRight = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const nextMust = mustSorted.find((m) => m > i);
    const fits = leftEdge(i) >= lastRight + LABEL_PAD && (nextMust === undefined || rightEdge(i) + LABEL_PAD <= leftEdge(nextMust));
    if (mustLabel.has(i) || fits) {
      labelIdx.add(i);
      lastRight = rightEdge(i);
    }
  }

  const last = pts[pts.length - 1];
  const endLabel = path.points[path.points.length - 1].label;
  const inStop = stopPrice != null && stopPrice >= yMin && stopPrice <= yMax;
  const inTarget = targetPrice != null && targetPrice >= yMin && targetPrice <= yMax;

  return (
    <div className="fc">
      <div className="fc-head">
        <strong>예상 경로</strong>
        <span className="fc-asof">
          {path.asOfLabel}
          {/* "오늘 움직일 몫이 얼마나 남았나" — 오후에 조회하면 남은 폭이 작다는 걸 숫자로 확인시킨다 */}
          {path.intradayRemainingPct > 0 && ` · 오늘 변동폭 ${Math.round(path.intradayRemainingPct)}% 남음`}
        </span>
      </div>
      <div className="fc-plot">
        <svg className="fc-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`예상 주가 경로 차트. ${path.note}`}>
          {/* 90% 구간 (옅은 바깥 띠) */}
          <path d={band((p) => p.p05, (p) => p.p95)} fill="var(--blue)" opacity="0.13" />
          {/* 50% 구간 (진한 안쪽 띠) */}
          <path d={band((p) => p.p25, (p) => p.p75)} fill="var(--blue)" opacity="0.28" />
          {/* 현재가 기준선 */}
          <line x1={PAD_L} x2={W - PAD_R} y1={y(path.currentPrice)} y2={y(path.currentPrice)} stroke="var(--text-weak)" strokeWidth="1" strokeDasharray="3 3" />
          {inStop && <line x1={PAD_L} x2={W - PAD_R} y1={y(stopPrice as number)} y2={y(stopPrice as number)} stroke="var(--red)" strokeWidth="1.2" strokeDasharray="5 3" />}
          {inTarget && <line x1={PAD_L} x2={W - PAD_R} y1={y(targetPrice as number)} y2={y(targetPrice as number)} stroke="var(--green)" strokeWidth="1.2" strokeDasharray="5 3" />}
          {/* 일 경계 세로선 — 여기서부터는 하룻밤(갭)을 건너뛴 구간이라는 표시 */}
          {pts.map((p, i) =>
            p.isDayBoundary && i < pts.length - 1 ? <line key={`b${i}`} x1={x(i)} x2={x(i)} y1={PAD_T} y2={H - PAD_B} stroke="var(--border)" strokeWidth="1" /> : null,
          )}
          <path d={medianPath} fill="none" stroke="var(--blue)" strokeWidth="1.6" />
          <circle cx={x(0)} cy={y(path.currentPrice)} r="2.8" fill="var(--blue)" />
        </svg>
        <div className="fc-ylabels" aria-hidden="true">
          <span style={{ top: `${pctY(yMax)}%` }}>{fmtTick(yMax, currency)}</span>
          <span className="cur" style={{ top: `${pctY(path.currentPrice)}%` }}>
            {fmtTick(path.currentPrice, currency)}
          </span>
          <span style={{ top: `${pctY(yMin)}%` }}>{fmtTick(yMin, currency)}</span>
        </div>
        <div className="fc-xlabels" aria-hidden="true">
          {pts.map((p, i) =>
            labelIdx.has(i) ? (
              <span key={i} className={p.isDayBoundary ? "b" : ""} style={{ left: `${pctX(i)}%` }}>
                {shortLabel(p.label)}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <div className="fc-legend">
        <span>
          <i className="sw sw-in" />
          절반(50%) 확률
        </span>
        <span>
          <i className="sw sw-out" />
          90% 확률
        </span>
        {inStop && (
          <span>
            <i className="sw sw-stop" />
            손절가
          </span>
        )}
        {inTarget && (
          <span>
            <i className="sw sw-target" />
            목표가
          </span>
        )}
      </div>
      {/* 지정가 후보 — 이 카드에서 사용자가 실제로 주문에 옮겨 적는 숫자 */}
      {path.orderLevels && (
        <>
          <div className={`fc-orders${sellingMode ? " one" : ""}`}>
            {!sellingMode && (
              <div className="fc-order buy">
                <div className="fc-order-k">이 값에 사면</div>
                <div className="fc-order-v">{fmtPrice(path.orderLevels.buyPrice, currency)}</div>
                <div className="fc-order-p">
                  {path.orderLevels.horizonLabel} 닿을 확률 <b>{path.orderLevels.buyProbPct}%</b>
                </div>
              </div>
            )}
            <div className="fc-order sell">
              <div className="fc-order-k">{sellingMode ? "정리 지정가 후보" : "이 값에 팔면"}</div>
              <div className="fc-order-v">{fmtPrice(path.orderLevels.sellPrice, currency)}</div>
              <div className="fc-order-p">
                {path.orderLevels.horizonLabel} 닿을 확률 <b>{path.orderLevels.sellProbPct}%</b>
              </div>
            </div>
          </div>
          {sellingMode && (
            <p className="fc-warn">지금은 엔진이 <b>정리(매도)</b>를 권하는 종목이라 매수 지정가는 표시하지 않습니다.</p>
          )}
        </>
      )}

      {/* 시간대별 예상 상·하단과 지정가 체결 확률 — "몇 시쯤 체결을 기대할 수 있나" */}
      <details className="fc-table">
        <summary>시간대별 예상 금액 · 체결 확률 보기</summary>
        <div className="fc-table-scroll">
          <table>
            <thead>
              <tr>
                <th>시점</th>
                <th>하단</th>
                <th>상단</th>
                {path.orderLevels && !sellingMode && <th>매수 체결</th>}
                {path.orderLevels && <th>매도 체결</th>}
              </tr>
            </thead>
            <tbody>
              {path.points.map((q, i) => (
                <tr key={i} className={q.isDayBoundary ? "b" : ""}>
                  <td>{q.label}</td>
                  <td>{fmtPrice(q.p25, currency)}</td>
                  <td>{fmtPrice(q.p75, currency)}</td>
                  {path.orderLevels && !sellingMode && <td>{q.buyFillProbPct}%</td>}
                  {path.orderLevels && <td>{q.sellFillProbPct}%</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fc-note">
          하단·상단은 그 시점에 도달 가능한 범위(절반 확률 구간)이고, 체결 확률은 위 지정가에 <b>그 시각까지 한 번이라도 닿을</b> 누적 확률입니다.
          5년 실측표({TOUCH_SAMPLE_SIZE.toLocaleString()}일) 기준이며 방향 예측이 아닙니다.
        </p>
      </details>

      <p className="fc-note">
        {endLabel} 90% 범위 {fmtPrice(last.p05, currency)} ~ {fmtPrice(last.p95, currency)}.
        <b> 오를지 내릴지는 예측하지 않습니다</b> — 방향 예측은 5년 데이터로 검증했을 때 적중률이 동전던지기보다 낮아 쓰지 않습니다.
      </p>
    </div>
  );
}
