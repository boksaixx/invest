// 시황(국면) 판별 — "지금 어떤 장인가"를 세 줄로, 그리고 "이런 장에서 이 신호가 얼마나 맞았나"를 숫자로.
//
// 국면은 모델 입력이 아니다(넣어 봤지만 확률 자체는 나아지지 않았다). 대신 같은 모델이 국면마다
// 얼마나 잘 맞았는지가 크게 달랐다 — 2019~2026 워크포워드 검증에서 변동성이 큰 장(최근 20일 σ가
// 120일 σ의 1.25배 초과)의 개장 모델 AUC 0.64 vs 보통 장 0.56. 그래서 화면에 국면을 보여 주고,
// "과거 비슷한 상황" 숫자도 같은 국면 표본이 충분하면(50건 이상) 그 국면 성적으로 보여 준다.
//
// 기준(학습 scripts/train-model.ts 와 화면이 같은 함수를 쓴다)
//  · 추세: 20일 이동평균 대비 위치(σ 단위) > +1 상승 / < -1 하락 / 그 사이 횡보
//  · 변동성: 최근 20일 σ ÷ 120일 σ > 1.25 변동 큰 장 / < 0.8 변동 작은 장 / 그 사이 보통 (최근 반년 대비 상대값)
import type { CalibRow, Features, ModelEval, RegimeEval } from "./predict";

export type RegimeKey = "vol:high" | "vol:normal" | "vol:calm" | "trend:up" | "trend:flat" | "trend:down";

export const VOL_HIGH = 1.25;
export const VOL_CALM = 0.8;
export const TREND_Z = 1;

export function regimeKeys(f: Features): RegimeKey[] {
  const out: RegimeKey[] = [];
  const v = f.volRegime;
  if (v != null && Number.isFinite(v)) out.push(v > VOL_HIGH ? "vol:high" : v < VOL_CALM ? "vol:calm" : "vol:normal");
  const t = f.ma20gapZ;
  if (t != null && Number.isFinite(t)) out.push(t > TREND_Z ? "trend:up" : t < -TREND_Z ? "trend:down" : "trend:flat");
  return out;
}

export const REGIME_LABEL: Record<RegimeKey, string> = {
  "vol:high": "변동 큰 장",
  "vol:normal": "보통 장",
  "vol:calm": "변동 작은 장",
  "trend:up": "상승 추세",
  "trend:flat": "옆걸음",
  "trend:down": "하락 추세",
};

export interface RegimeLine {
  label: string; // "추세" / "변동성" / "간밤 미국" / "지금 시장"
  value: string; // "상승 추세"
  detail: string; // "20일선보다 +4.2% 위 · 한 달 +11%"
  tone: "up" | "down" | "flat";
}
export interface RegimeView {
  headline: string; // "상승 추세 · 출렁이는 장"
  lines: RegimeLine[];
  /** 이 국면에서 오늘 신호(단타 모델)의 검증 성적 — 표본이 충분할 때만 */
  edge: { key: RegimeKey; text: string; auc: number; n: number; better: boolean | null } | null;
  keys: RegimeKey[];
}

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

/** 강하게 말했을 때(≥55% / ≤45%) 맞힌 비율 */
function sideHit(calib: CalibRow[], base: number): { n: number; hit: number; naive: number } | null {
  let n = 0, hit = 0, naive = 0;
  for (const r of calib) {
    if (r.lo >= 0.55) { n += r.n; hit += (r.n * r.upPct) / 100; naive += (r.n * base) / 100; }
    else if (r.hi <= 0.45) { n += r.n; hit += (r.n * (100 - r.upPct)) / 100; naive += (r.n * (100 - base)) / 100; }
  }
  return n ? { n, hit: (hit / n) * 100, naive: (naive / n) * 100 } : null;
}

/** 지금 국면에서 쓸 성적 — 표본 50건 이상인 국면 중 변동성 → 추세 순으로 */
export function regimeEvalFor(ev: ModelEval | null | undefined, keys: RegimeKey[]): { key: RegimeKey; ev: RegimeEval } | null {
  if (!ev?.byRegime) return null;
  for (const k of [...keys].sort((a, b) => (a.startsWith("vol") ? -1 : 1) - (b.startsWith("vol") ? -1 : 1))) {
    const r = ev.byRegime[k];
    if (r && r.n >= 50) return { key: k, ev: r };
  }
  return null;
}

export function describeRegime(params: {
  f: Features;
  sigma: number | null;
  overnight: { nvdaPct: number | null; soxPct: number | null; muPct?: number | null } | null;
  market: { kospiPct: number | null; nqPct: number | null; usdkrwPct: number | null } | null;
  dayEval: ModelEval | null;
}): RegimeView {
  const { f, sigma } = params;
  const keys = regimeKeys(f);
  const lines: RegimeLine[] = [];
  const trendKey = keys.find((k) => k.startsWith("trend")) as RegimeKey | undefined;
  const volKey = keys.find((k) => k.startsWith("vol")) as RegimeKey | undefined;

  if (trendKey && sigma) {
    const gap20 = (f.ma20gapZ ?? 0) * sigma;
    const r20 = f.ret20Z != null ? f.ret20Z * sigma * Math.sqrt(20) : null;
    const gap60 = f.ma60gapZ != null ? f.ma60gapZ * sigma : null;
    lines.push({
      label: "추세",
      value: REGIME_LABEL[trendKey],
      detail: [`20일선보다 ${pct(gap20)}`, gap60 != null ? `60일선보다 ${pct(gap60)}` : null, r20 != null ? `한 달 ${pct(r20, 0)}` : null].filter(Boolean).join(" · "),
      tone: trendKey === "trend:up" ? "up" : trendKey === "trend:down" ? "down" : "flat",
    });
  }
  if (volKey && sigma) {
    lines.push({
      label: "변동성",
      value: REGIME_LABEL[volKey],
      detail: `요즘 하루 평균 ±${sigma.toFixed(1)}% · 최근 반년 평균의 ${((f.volRegime ?? 1) * 100).toFixed(0)}%`,
      tone: "flat",
    });
  }
  const on = params.overnight;
  if (on && (on.nvdaPct != null || on.soxPct != null || on.muPct != null)) {
    const parts = [
      on.soxPct != null ? `반도체지수 ${pct(on.soxPct)}` : null,
      on.nvdaPct != null ? `엔비디아 ${pct(on.nvdaPct)}` : null,
      on.muPct != null ? `마이크론 ${pct(on.muPct)}` : null,
    ].filter(Boolean) as string[];
    const avg = [on.soxPct, on.nvdaPct, on.muPct].filter((x): x is number => x != null);
    const m = avg.reduce((a, b) => a + b, 0) / Math.max(1, avg.length);
    lines.push({
      label: "간밤 미국",
      value: m >= 1.5 ? "반도체 강세" : m <= -1.5 ? "반도체 약세" : m >= 0.3 ? "조금 강세" : m <= -0.3 ? "조금 약세" : "보합",
      detail: parts.join(" · "),
      tone: m >= 0.3 ? "up" : m <= -0.3 ? "down" : "flat",
    });
  }
  const mk = params.market;
  if (mk && (mk.kospiPct != null || mk.nqPct != null || mk.usdkrwPct != null)) {
    const parts = [
      mk.kospiPct != null ? `코스피 ${pct(mk.kospiPct, 2)}` : null,
      mk.nqPct != null ? `나스닥 선물 ${pct(mk.nqPct, 2)}` : null,
      mk.usdkrwPct != null ? `원/달러 ${pct(mk.usdkrwPct, 2)}` : null,
    ].filter(Boolean) as string[];
    const k = mk.kospiPct ?? 0;
    lines.push({
      label: "지금 시장",
      value: k >= 1 ? "강세" : k <= -1 ? "약세" : k >= 0.3 ? "조금 강세" : k <= -0.3 ? "조금 약세" : "보합",
      detail: parts.join(" · "),
      tone: k >= 0.3 ? "up" : k <= -0.3 ? "down" : "flat",
    });
  }

  let edge: RegimeView["edge"] = null;
  const re = regimeEvalFor(params.dayEval, keys);
  if (re && params.dayEval) {
    const s = sideHit(re.ev.calib, re.ev.baseUpPct);
    const overall = params.dayEval.auc;
    const better = re.ev.auc >= overall + 0.02 ? true : re.ev.auc <= overall - 0.02 ? false : null;
    const name = REGIME_LABEL[re.key];
    const hitTxt = s && s.n >= 30 ? ` 강하게 말한 ${s.n.toLocaleString("ko-KR")}번 중 ${Math.round(s.hit)}% 적중 (근거 없이 찍으면 ${Math.round(s.naive)}%).` : "";
    edge = {
      key: re.key,
      auc: re.ev.auc,
      n: re.ev.n,
      better,
      text:
        better === true
          ? `${name}에서 신호가 평소보다 잘 맞았어요.${hitTxt}`
          : better === false
            ? `${name}에서는 신호가 평소보다 덜 맞았어요.${hitTxt} 그래서 살 때 수량을 30% 줄여요.`
            : `${name}에서도 신호가 평소만큼 맞았어요.${hitTxt}`,
    };
  }

  const headline = [trendKey ? REGIME_LABEL[trendKey] : null, volKey ? REGIME_LABEL[volKey] : null].filter(Boolean).join(" · ") || "판단 중";
  return { headline, lines, edge, keys };
}
