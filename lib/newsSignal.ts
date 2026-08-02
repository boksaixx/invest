// 뉴스를 "읽을 거리"가 아니라 "집계 가능한 신호"로 바꾼다.
//
// 왜 만들었나: 지금까지는 수집한 뉴스 중 10건만 Claude에게 원문으로 넘기고 나머지는 버렸다.
// 토큰을 아끼려는 선택이었는데, 뉴스가 몇 건뿐이면 그 몇 건으로 상황을 오판할 위험이 더 크다.
//
// 해법은 "수집"과 "전송"을 분리하는 것이다.
//   · 수집은 최대한 많이 (Gemini 비용이지 Claude 토큰이 아니다)
//   · 전송은 두 갈래로 — (1) 전체를 유형별로 집계한 압축 통계, (2) 영향도 상위 원문 일부
// 이렇게 하면 80건을 수집해도 Claude에 가는 토큰은 오히려 줄어든다. 집계 한 줄이
// 원문 여러 건보다 짧으면서, "지금 악재가 몇 건이고 어느 축에 몰려 있는지"를 더 정확히 전한다.
//
// 정직한 한계: 이 집계는 "사실의 요약"이지 "가격 예측"이 아니다. 뉴스 유형과 다음날 등락을
// 연결하려면 과거 뉴스를 라벨링한 데이터가 있어야 하는데 그런 자료가 없다. 그래서 이 값으로
// 점수를 새로 만들지 않고, 이미 검증 없이 쓰던 기존 감성 점수(newsSentimentScore)의 범위를
// 넘지 않도록 두고, 사람과 Claude가 판단에 쓰도록 그대로 보여준다.
import type { NewsItem } from "./types";

/** 뉴스가 어느 축을 건드리는지 — 축마다 영향 경로가 다르다 */
const AXES: { axis: string; match: RegExp; note: string }[] = [
  { axis: "업황", match: /반도체업황|D램|낸드|HBM|현물가|가동률|파운드리/, note: "메모리 사이클 — 국내 반도체 전반" },
  { axis: "지정학", match: /지정학|관세|수출규제|전쟁|중동|이란|미중/, note: "리스크 프리미엄 — 지수 전체에 하방 압력" },
  { axis: "중국", match: /중국반도체|SMIC|YMTC|CXMT|중국/, note: "판가 경쟁 — 국내 메모리 마진 직격" },
  { axis: "실적", match: /실적전망|가이던스|어닝|컨센서스|TSMC|마이크론|ASML/, note: "실적 방향 — 개별 종목 재평가" },
  { axis: "큰손", match: /큰손동향|버리|버핏|13F|공매도|연기금/, note: "수급 심리 — 과열·침체 판단 보조" },
  { axis: "매크로", match: /매크로|금리|환율|국채|유가|CPI|연준/, note: "할인율·환율 — 밸류에이션 압력" },
  { axis: "지수", match: /지수|코스피|나스닥|S&P|SOX|선물|VIX/, note: "시장 전체 방향" },
];

export interface NewsAxis {
  axis: string;
  total: number;
  positive: number;
  negative: number;
  highImpact: number;
  /** 부정 - 긍정 (영향도 가중). 음수면 악재 우위 */
  pressure: number;
  note: string;
}

export interface NewsSignal {
  available: boolean;
  collected: number; // 수집된 전체 건수
  breaking: number; // 속보(3시간 이내 + 고영향) 건수
  positive: number;
  negative: number;
  neutral: number;
  highImpact: number;
  /** 전체 압력 지수 (음수=악재 우위). 영향도 가중 합을 건수로 나눈 값 */
  pressure: number;
  axes: NewsAxis[]; // 축별 집계 (건수 많은 순)
  /** Claude·화면에 그대로 쓸 한 줄 요약 */
  summary: string;
  /** 뉴스가 너무 적어 판단 근거로 삼기 어려운 상태인지 */
  thin: boolean;
}

const weight = (n: NewsItem) => (n.impact === "높음" ? 3 : n.impact === "중간" ? 2 : 1);
const signed = (n: NewsItem) => (n.sentiment === "긍정" ? weight(n) : n.sentiment === "부정" ? -weight(n) : 0);

/** 뉴스 목록 전체를 유형별로 집계한다. 몇 건을 수집했든 결과 크기는 일정하다. */
export function computeNewsSignal(news: NewsItem[]): NewsSignal {
  const empty: NewsSignal = {
    available: false,
    collected: 0,
    breaking: 0,
    positive: 0,
    negative: 0,
    neutral: 0,
    highImpact: 0,
    pressure: 0,
    axes: [],
    summary: "수집된 뉴스가 없습니다 — 뉴스 근거 없이 기술적 지표만으로 판단해야 합니다.",
    thin: true,
  };
  if (news.length === 0) return empty;

  const positive = news.filter((n) => n.sentiment === "긍정").length;
  const negative = news.filter((n) => n.sentiment === "부정").length;
  const highImpact = news.filter((n) => n.impact === "높음").length;
  const breaking = news.filter((n) => n.isBreaking).length;
  const pressureSum = news.reduce((a, n) => a + signed(n), 0);
  const pressure = Number((pressureSum / news.length).toFixed(2));

  const axes: NewsAxis[] = [];
  for (const { axis, match, note } of AXES) {
    const hit = news.filter((n) => match.test(n.relatedTo) || match.test(n.title));
    if (hit.length === 0) continue;
    const pos = hit.filter((n) => n.sentiment === "긍정").length;
    const neg = hit.filter((n) => n.sentiment === "부정").length;
    axes.push({
      axis,
      total: hit.length,
      positive: pos,
      negative: neg,
      highImpact: hit.filter((n) => n.impact === "높음").length,
      pressure: Number((hit.reduce((a, n) => a + signed(n), 0) / hit.length).toFixed(2)),
      note,
    });
  }
  axes.sort((a, b) => b.total - a.total);

  // 뉴스가 12건 미만이면 "몇 건으로 전체를 판단"하는 상황이라 그 사실을 알려야 한다
  const thin = news.length < 12;
  const tone = pressure <= -0.6 ? "악재 우위" : pressure >= 0.6 ? "호재 우위" : "혼조";
  const axisPart = axes
    .slice(0, 4)
    .map((a) => `${a.axis} ${a.total}건(${a.pressure >= 0 ? "+" : ""}${a.pressure})`)
    .join(" · ");
  const summary =
    `수집 ${news.length}건 · ${tone}(압력 ${pressure >= 0 ? "+" : ""}${pressure}) · 속보 ${breaking}건 · 고영향 ${highImpact}건` +
    (axisPart ? ` | ${axisPart}` : "") +
    (thin ? " ⚠ 표본이 적어 오판 위험" : "");

  return { available: true, collected: news.length, breaking, positive, negative, neutral: news.length - positive - negative, highImpact, pressure, axes, summary, thin };
}

/**
 * Claude에 원문으로 보낼 뉴스를 고른다.
 *
 * 전부 보내면 80건 × 약 105자 = 8,400자(약 3,800토큰)로 페이로드가 배로 뛴다.
 * 그렇다고 앞에서 N건만 자르면 특정 축(예: 지정학)이 통째로 빠질 수 있다.
 * 그래서 (1) 속보·고영향은 우선 담고, (2) 각 축에서 최소 1건씩은 반드시 남겨
 * "무슨 일이 벌어지는지"의 지형이 빠지지 않게 한다.
 */
export function selectNewsForPrompt(news: NewsItem[], limit = 12): NewsItem[] {
  if (news.length <= limit) return news;
  const rank = (n: NewsItem) => (n.isBreaking ? 100 : 0) + (n.impact === "높음" ? 10 : n.impact === "중간" ? 5 : 0);
  const picked: NewsItem[] = [];
  const used = new Set<NewsItem>();

  // 축별 대표 1건 먼저 확보 (지형이 빠지지 않도록)
  for (const { match } of AXES) {
    const best = news
      .filter((n) => !used.has(n) && (match.test(n.relatedTo) || match.test(n.title)))
      .sort((a, b) => rank(b) - rank(a))[0];
    if (best && picked.length < limit) {
      picked.push(best);
      used.add(best);
    }
  }
  // 남은 자리는 영향도 순으로 채운다
  for (const n of [...news].sort((a, b) => rank(b) - rank(a))) {
    if (picked.length >= limit) break;
    if (used.has(n)) continue;
    picked.push(n);
    used.add(n);
  }
  return picked;
}
