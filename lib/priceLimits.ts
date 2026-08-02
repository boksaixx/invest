// 국내 주식의 "가격이 멈추는 지점" — 상한가·하한가와 변동성완화장치(VI) 발동가.
//
// 왜 필요한가: 이 앱은 지정가를 제시하는데, 국내 시장에는 가격이 특정 지점에 닿으면
// 거래 방식 자체가 바뀌는 구간이 있다. 초보자는 이걸 모르고 주문을 걸어두었다가
// "왜 체결이 안 되지", "왜 갑자기 호가가 사라졌지"를 겪는다.
//
//  · 상한가/하한가 — 전일 종가 대비 ±30%. 이 밖으로는 아예 체결되지 않는다.
//  · 정적VI — 당일 기준가(전일 종가) 대비 ±10% 체결 시 발동. 약 2분간 단일가매매로 전환된다.
//    호가창이 잠시 멈추므로, VI 구간 너머에 지정가를 걸어두면 즉시 체결을 기대할 수 없다.
//
// 정직한 한계: 동적VI(직전 체결가 대비 소폭 급변 시 발동)는 기준가가 실시간 체결가라
// 15~20분 지연되는 무료 시세로는 정확히 계산할 수 없어 제외했다. 또 정적VI 기준가는
// 원칙적으로 전일 종가지만, 배당락·권리락·거래정지 해제일 등에는 거래소가 별도 기준가를
// 정한다. 그런 날은 아래 값이 어긋날 수 있으므로 증권사 화면을 우선하라고 안내한다.
import { roundToTick } from "./tick";

/** 가격제한폭 — 코스피·코스닥 공통 ±30% */
const LIMIT_PCT = 30;
/** 정적VI 발동 기준 — 기준가 대비 ±10% */
const STATIC_VI_PCT = 10;

export interface PriceLimits {
  available: boolean;
  /** 계산 기준이 된 전일 종가 */
  basePrice: number;
  upperLimit: number; // 상한가
  lowerLimit: number; // 하한가
  viUpper: number; // 정적VI 상단
  viLower: number; // 정적VI 하단
  /** 현재가가 어디쯤인지 — 사람이 읽는 한 줄 */
  note: string;
  /** 지금 이미 VI 구간을 넘었는지 */
  beyondVi: "상단" | "하단" | null;
}

export function computePriceLimits(basePrice: number | null | undefined, currentPrice: number | null | undefined): PriceLimits {
  const empty: PriceLimits = {
    available: false, basePrice: 0, upperLimit: 0, lowerLimit: 0, viUpper: 0, viLower: 0, note: "", beyondVi: null,
  };
  if (!basePrice || !Number.isFinite(basePrice) || basePrice <= 0) return empty;
  if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) return empty;

  // 호가단위로 맞춰야 실제로 주문 가능한 값이 된다. 방향은 보수적으로:
  // 상단은 내려서(도달이 더 쉬운 쪽), 하단은 올려서 잡는다.
  const upperLimit = roundToTick(basePrice * (1 + LIMIT_PCT / 100), "KRW", "down");
  const lowerLimit = roundToTick(basePrice * (1 - LIMIT_PCT / 100), "KRW", "up");
  const viUpper = roundToTick(basePrice * (1 + STATIC_VI_PCT / 100), "KRW", "down");
  const viLower = roundToTick(basePrice * (1 - STATIC_VI_PCT / 100), "KRW", "up");

  const changePct = ((currentPrice - basePrice) / basePrice) * 100;
  const beyondVi = currentPrice >= viUpper ? "상단" : currentPrice <= viLower ? "하단" : null;

  const won = (v: number) => `${v.toLocaleString("ko-KR")}원`;
  let note: string;
  if (currentPrice >= upperLimit) {
    note = `상한가(${won(upperLimit)})입니다. 오늘은 이 위로 체결되지 않습니다.`;
  } else if (currentPrice <= lowerLimit) {
    note = `하한가(${won(lowerLimit)})입니다. 오늘은 이 아래로 체결되지 않습니다.`;
  } else if (beyondVi === "상단") {
    note = `이미 VI 상단(${won(viUpper)})을 넘었습니다 — 급등으로 거래가 잠시 멈췄을 수 있습니다. 상한가는 ${won(upperLimit)}입니다.`;
  } else if (beyondVi === "하단") {
    note = `이미 VI 하단(${won(viLower)})을 넘었습니다 — 급락으로 거래가 잠시 멈췄을 수 있습니다. 하한가는 ${won(lowerLimit)}입니다.`;
  } else {
    const toUp = ((viUpper - currentPrice) / currentPrice) * 100;
    const toDown = ((currentPrice - viLower) / currentPrice) * 100;
    note =
      `여기서 ${toUp.toFixed(1)}% 더 오르면 ${won(viUpper)}에서, ${toDown.toFixed(1)}% 더 빠지면 ${won(viLower)}에서 ` +
      `거래가 약 2분간 멈춥니다(VI). 오늘 체결 가능한 범위는 ${won(lowerLimit)} ~ ${won(upperLimit)}입니다.`;
  }
  if (Math.abs(changePct) >= 20) note += ` (현재 전일 대비 ${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%)`;

  return { available: true, basePrice, upperLimit, lowerLimit, viUpper, viLower, note, beyondVi };
}

/** 제시한 지정가가 오늘 체결 불가능한 구간인지 검사한다 */
export function checkOrderPrice(price: number | null, limits: PriceLimits): string | null {
  if (price == null || !limits.available) return null;
  if (price > limits.upperLimit) return `${price.toLocaleString("ko-KR")}원은 오늘 상한가(${limits.upperLimit.toLocaleString("ko-KR")}원)를 넘어 체결될 수 없습니다.`;
  if (price < limits.lowerLimit) return `${price.toLocaleString("ko-KR")}원은 오늘 하한가(${limits.lowerLimit.toLocaleString("ko-KR")}원)보다 낮아 체결될 수 없습니다.`;
  return null;
}
