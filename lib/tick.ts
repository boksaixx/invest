// 호가단위(tick size) — 앱이 제시하는 가격을 "실제로 주문 가능한 값"으로 만든다.
//
// 왜 필요한가: 이 앱의 목적은 사용자가 화면의 숫자를 그대로 증권사 주문창에 옮겨 적는 것이다.
// 그런데 계산 결과를 1원 단위로 반올림해서 보여주면, 삼성전자(호가 500원)에 247,354원 같은
// 값이 나온다 — 증권사 앱에 입력 자체가 안 되는 숫자다. 사용자는 그 자리에서 임의로 반올림하게
// 되고, 그러면 손절폭·리스크 계산이 앱이 말한 것과 달라진다.
// 미국 종목은 더 심각했다. Math.round()가 센트를 통째로 날려 $195.04 종목의 손절가가
// $183(실제 $182.65)으로 나왔다.
//
// KRX 호가가격단위 (2023년 1월 통합 개정, 유가증권·코스닥 공통):
//   2,000원 미만 1원 / 2,000~5,000 5원 / 5,000~20,000 10원 / 20,000~50,000 50원
//   50,000~200,000 100원 / 200,000~500,000 500원 / 500,000 이상 1,000원
// 미국 주식은 $0.01 (1센트).

const KRX_TICKS: [number, number][] = [
  [2_000, 1],
  [5_000, 5],
  [20_000, 10],
  [50_000, 50],
  [200_000, 100],
  [500_000, 500],
  [Infinity, 1_000],
];

/** 해당 가격대의 호가단위 */
export function tickSize(price: number, currency: "KRW" | "USD"): number {
  if (currency === "USD") return 0.01;
  const p = Math.abs(price);
  return KRX_TICKS.find(([limit]) => p < limit)![1];
}

/**
 * 실제 주문 가능한 호가로 맞춘다.
 *
 * mode를 방향별로 다르게 쓰는 이유(전부 "앱이 말한 것보다 불리해지지 않도록"):
 *  - "up"   : 손절가에 쓴다. 내리면 손절폭이 넓어져 실제 리스크가 계산치를 넘는다.
 *  - "down" : 목표가·익절가에 쓴다. 올리면 도달이 더 어려워져 제시한 확률보다 불리해진다.
 *  - "nearest": 매수·매도 지정가 후보. 호가 한 칸은 가격의 0.2% 미만이라 어느 쪽으로 붙여도
 *               모델 오차(σ 단위)에 비해 무시할 수준이므로 가장 가까운 유효 호가를 쓴다.
 */
export function roundToTick(price: number, currency: "KRW" | "USD", mode: "nearest" | "up" | "down" = "nearest"): number {
  if (!isFinite(price) || price <= 0) return price;
  const t = tickSize(price, currency);
  const q = price / t;
  const n = mode === "up" ? Math.ceil(q) : mode === "down" ? Math.floor(q) : Math.round(q);
  const out = n * t;
  // 부동소수 오차 제거 (USD 0.01 단위에서 189.99999999 같은 값이 나오는 것을 막는다)
  return currency === "USD" ? Math.round(out * 100) / 100 : Math.round(out);
}

/** 호가단위를 사람이 읽는 문자열로 (안내 문구용) */
export function tickLabel(price: number, currency: "KRW" | "USD"): string {
  const t = tickSize(price, currency);
  return currency === "USD" ? `$${t.toFixed(2)}` : `${t.toLocaleString()}원`;
}
