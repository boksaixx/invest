// 도달 확률 — "이 가격에 지정가를 걸면 닿을까"
//
// 방향 예측(오를까 내릴까)은 검증에서 실패했다(scripts/validate-analog.ts: 적중률 47~50%,
// 기준선 미달, 따라가면 평균 손실). 그래서 이 앱은 방향을 예측하지 않는다.
//
// 대신 단타에서 실제로 필요한 판단인 "내가 건 지정가에 닿을까"를 계산한다. 이건 방향이 아니라
// 변동폭의 문제이고, 변동폭은 검증된 모델이 이미 잘 맞힌다(90% 구간 적중률 88%).
//
// 확률은 이론식이 아니라 실측표를 쓴다. 반사원리 이론값은 실제보다 20% 정도 높게 나왔다
// (하루 한 세션만 열리고 갭으로 시작하는 실제 시장과 연속 랜덤워크 가정의 차이).
// 표는 scripts/validate-touch.ts가 5년 실데이터로 생성한다 → data/touch-stats.json
import touchStats from "../data/touch-stats.json";

type CalibRow = { kSigma: number; theoryPct: number; downPct: number; upPct: number; avgPct: number; n: number };
const CALIB = (touchStats.calibration as CalibRow[]).slice().sort((a, b) => a.kSigma - b.kSigma);

/**
 * 현재가에서 kσ 떨어진 지점에 "기간 중 한 번이라도" 닿을 확률(%).
 *
 * 상단과 하단을 따로 쓴다 — 실측상 상단 도달률이 하단보다 일관되게 높다(0.3σ에서 65% vs 60%).
 * 국내 반도체주의 상방 꼬리가 더 두껍기 때문이며(상한가 현상), 평균으로 뭉개면 이 비대칭이 사라진다.
 */
export function touchProbability(kSigma: number, side: "up" | "down"): number {
  const k = Math.abs(kSigma);
  const pick = (r: CalibRow) => (side === "up" ? r.upPct : r.downPct);
  if (k <= CALIB[0].kSigma) {
    // 표의 최소 거리보다 가까우면 그 값에서 100%로 선형 접근 (거리 0이면 반드시 닿음)
    const r0 = CALIB[0];
    const t = k / r0.kSigma;
    return Math.min(100, 100 - t * (100 - pick(r0)));
  }
  for (let i = 1; i < CALIB.length; i++) {
    if (k <= CALIB[i].kSigma) {
      const a = CALIB[i - 1];
      const b = CALIB[i];
      const t = (k - a.kSigma) / (b.kSigma - a.kSigma);
      return pick(a) + t * (pick(b) - pick(a));
    }
  }
  // 표 밖(2σ 초과)은 마지막 구간의 감소율로 외삽하되 0 아래로는 내려가지 않게 한다
  const last = CALIB[CALIB.length - 1];
  const prev = CALIB[CALIB.length - 2];
  const slope = (pick(last) - pick(prev)) / (last.kSigma - prev.kSigma);
  return Math.max(0.2, pick(last) + slope * (k - last.kSigma));
}

/** 확률(%)을 초보자용 한마디로 */
export function touchProbLabel(pct: number): string {
  if (pct >= 70) return "거의 확실";
  if (pct >= 50) return "절반 이상";
  if (pct >= 30) return "가능";
  if (pct >= 15) return "낮음";
  return "희박";
}

export const TOUCH_SAMPLE_SIZE = (CALIB[0]?.n ?? 0) as number;
