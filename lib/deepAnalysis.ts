// AI 심층 분석 — 검증된 숫자를 전부 받은 Claude가 시황 → 추세 → 수급 → 뉴스 → 결론 → "이렇게 되면 이렇게"로 정리한다.
//
// 역할 분담 (예전 "정밀 분석"이 실패한 이유를 되풀이하지 않기 위한 원칙)
//  · 사라/기다려라/팔아라 결론과 확률·수량·손절가는 검증된 모델과 안전 규칙(lib/quickCore.ts)이 이미 정했다.
//    예전 AI 분석은 스스로 방향을 정했고, 그 점수는 5개년 검증에서 실제 주가와 거꾸로 갔다.
//  · AI는 그 결론을 뒤집지 못한다. 하는 일은 ① 왜 그런지 사람 말로 풀고 ② 숫자에 안 잡히는 뉴스·수급 맥락을 보태고
//    ③ 가격 조건별 시나리오(○○원 넘으면 / △△원 깨지면)를 세우는 것.
//  · 가드레일: AI의 방향(stance)이 검증된 확률·결론과 반대면 "중립"으로 바꾸고 그 사실을 표시한다.
//    시나리오 가격이 현재가 ±15% 밖이면 지운다. 화면은 AI 방향도 그날 종가로 따로 채점한다.
import Anthropic from "@anthropic-ai/sdk";
import { computeUsage, DEFAULT_ADVICE_MODEL, describeAnthropicError, type AdviceUsage } from "./claude";
import { DAY_BUY_PROB, DAY_WEAK_PROB } from "./decide";
import { REGIME_LABEL, type RegimeKey } from "./regime";
import { roundToTick } from "./tick";
import { classifyDisclosure } from "./liveNews";
import type { NewsItem } from "./types";
import type { QuickContext, StockContext } from "./quickCore";
import { IN_SESSION } from "./quickCore";

const MODEL = process.env.CLAUDE_DEEP_MODEL || process.env.CLAUDE_MODEL || DEFAULT_ADVICE_MODEL;

export type Stance = "up" | "down" | "neutral";
export interface DeepScenario {
  trigger: string; // "235,000원 위로 올라서면"
  price: number; // 기준 가격 (없으면 0)
  action: string; // "절반 익절, 나머지는 손절가를 본전으로"
}
export interface DeepStock {
  ticker: "005930" | "000660";
  headline: string;
  stance: Stance;
  confidence: "낮음" | "보통" | "높음";
  market: string;
  trend: string;
  flow: string;
  news: string;
  conclusion: string;
  scenarios: DeepScenario[];
  watch: string[];
  risks: string[];
  /** 가드레일이 손댄 내용 (화면에 작게 표시) */
  guard?: string[];
  /** 채점용: 분석 시점 가격·확률 */
  at?: { price: number; dayProb: number | null; checkpoint: string | null; inSession: boolean };
}
export interface DeepAnalysis {
  generatedAt: string;
  phase: string;
  kstTime: string;
  marketView: string;
  stocks: DeepStock[];
  model: string;
}

const STR = { type: "string" } as const;
const DEEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    marketView: { type: "string", description: "오늘 시황 종합 2~3문장 (간밤 미국 → 지금 국내 → 두 종목에 주는 의미)" },
    stocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ticker: { type: "string", enum: ["005930", "000660"] },
          headline: { type: "string", description: "한 줄 요약 (30자 안팎). 앱 결론과 같은 방향" },
          stance: { type: "string", enum: ["up", "down", "neutral"], description: "오늘 종가까지 방향에 대한 기울기" },
          confidence: { type: "string", enum: ["낮음", "보통", "높음"] },
          market: { ...STR, description: "시황: 간밤 미국·국내 시장·국면이 이 종목에 주는 영향 1~3문장" },
          trend: { ...STR, description: "추세·가격 흐름: 이동평균·최근 고저·오늘 장중 위치 1~3문장" },
          flow: { ...STR, description: "수급: 외국인·기관 최근 흐름 1~2문장 (방향 예측력은 약하다는 점을 감안)" },
          news: { ...STR, description: "뉴스: 이 종목 기준으로 다시 읽은 호재·악재 1~2문장. 없으면 '눈에 띄는 뉴스 없음'" },
          conclusion: { ...STR, description: "결론: 앱 결론을 따르는 구체적 행동 2~3문장" },
          scenarios: {
            type: "array",
            description: "가격 조건별 대응 2~3개",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                trigger: { ...STR, description: "예: '235,000원 위로 올라서면'" },
                price: { type: "number", description: "trigger 기준 가격(원). 가격 조건이 아니면 0" },
                action: { ...STR, description: "그때 할 일" },
              },
              required: ["trigger", "price", "action"],
            },
          },
          watch: { type: "array", items: STR, description: "지금 지켜볼 것 2~3개 (짧게)" },
          risks: { type: "array", items: STR, description: "이 판단이 틀릴 수 있는 이유 1~2개" },
        },
        required: ["ticker", "headline", "stance", "confidence", "market", "trend", "flow", "news", "conclusion", "scenarios", "watch", "risks"],
      },
    },
  },
  required: ["marketView", "stocks"],
} as const;

const SYSTEM = `당신은 삼성전자·SK하이닉스 두 종목만 다루는 한국 주식 단기 트레이딩 분석가입니다. 고객은 실제 돈으로 단타(당일 청산)와 며칠 보유(스윙)를 둘 다 합니다. 투자 초보라 쉬운 한국어로 짧게 쓰되, 판단은 프로처럼 구체적이어야 합니다.

[역할 — 가장 중요]
- 각 종목의 "앱 결론"(decision)은 2016~2026 데이터로 검증된 확률 모델과 안전 규칙(손절·수량·하루 손실 한도)이 이미 정한 것입니다. 당신은 이 결론을 바꾸거나 반대로 권하면 안 됩니다.
- 당신의 일: ① 결론이 왜 나왔는지 시황→추세→수급→뉴스 순서로 풀어 설명 ② 숫자에 안 잡히는 뉴스·수급 맥락을 보탬 ③ "이 가격을 넘으면/깨지면 이렇게" 시나리오를 세움.

[숫자 규칙]
- 숫자는 입력 데이터에 있는 것만 인용하세요. 새로운 확률·적중률·목표가를 지어내지 마세요.
- 시나리오의 기준 가격은 입력의 levels, today, plan, stopPrice 중에서 고르세요(현재가 ±15% 안). 원 단위 정수로.
- 가격은 "235,000원"처럼 쉼표와 '원'을 붙이세요.

[방향(stance) 규칙]
- dayProb ≥ 0.55 이면 up 또는 neutral, ≤ 0.45 이면 down 또는 neutral 만 고르세요.
- 0.45~0.55 사이(반반)일 때만, 뉴스·추세·수급 근거가 뚜렷하면 up/down 으로 기울일 수 있습니다. 근거가 약하면 neutral.
- 앱 결론이 손절·매도면 up 금지, 매수면 down 금지.
- confidence 는 근거가 서로 같은 방향으로 모일 때만 "높음". 대부분은 "보통" 또는 "낮음"이 정직합니다.

[검증된 사실 — 해석의 기준으로 쓰세요]
validatedFacts 목록은 과거 데이터로 실제 확인된 패턴입니다. 이와 어긋나는 일반론(예: "미국 반도체가 올랐으니 오늘 오른다")을 결론의 근거로 쓰지 마세요. 간밤 미국 강세는 시가에 이미 반영되고 장중엔 오히려 밀린 경우가 많았습니다.
수급(외국인·기관)과 나스닥 선물·환율·코스피 장중 등락은 검증에서 방향 예측력을 더하지 못했습니다 — 맥락 설명에만 쓰고 결론의 핵심 근거로 쓰지 마세요.
며칠(3거래일) 방향은 거의 예측되지 않았습니다(참고용). 며칠 전망을 단정하지 마세요.

[뉴스·공시·일정 해석 규칙]
- headlines·각 종목 news는 실시간 수집(네이버·구글 뉴스·거래소 공시)과 Gemini 정리본입니다. tone_자동은 제목 키워드로 붙인 값이라 틀릴 수 있으니 제목과 맥락으로 직접 다시 판단하세요.
- 트럼프·백악관 발언, 관세, 반도체 수출통제, 중국 반도체(CXMT·YMTC·SMIC), 메모리 가격·HBM, 자사주 매입·소각, 실적 공시가 있으면 market 또는 news 칸에서 반드시 다루고 "언제(몇 시간 전), 어디서" 나온 얘기인지 밝히세요.
- 같은 사안을 여러 매체가 반복 보도한 것을 여러 건의 독립 호재·악재로 세지 마세요. 12시간 넘은 기사는 이미 주가에 반영됐을 가능성이 크다고 보세요.
- 중국 메모리 업체의 증설·신제품은 두 종목에 경쟁 악재, 미국의 대중 수출통제는 두 종목에 영향이 엇갈릴 수 있습니다(중국 경쟁사 견제 vs 두 종목의 중국 공장·매출). 한쪽으로 단정하지 마세요.
- 자사주 매입 공시는 과거 삼성전자 14번 평균 당일 +1.3%(코스피 대비 +0.5%)로 효과가 작고 들쭉날쭉했습니다. 실적 발표일은 시가→종가가 평균 -0.3~-0.4%로 장중에 밀린 경우가 조금 더 많았습니다(표본 적음). 과장하지 마세요.
- upcomingEvents 중 장중(15:30 전)에 있는 것은 scenarios에 발표 전후 대응을 넣으세요. 장 마감 뒤 이벤트는 들고 넘길 물량 관점으로만.

[행동 규칙]
- 오후(13시 이후) 신규 단타 매수를 권하지 마세요 — 맞아도 남은 기대수익이 왕복 비용(약 0.18%)을 못 넘었습니다.
- 하루 손실 한도 도달, 상한가·하한가 날에는 신규 매수를 권하지 마세요.
- 보유 중이면 손절가를 반드시 함께 말하세요. 손절가를 내리라고(넓히라고) 권하지 마세요.
- 장이 닫혀 있으면 "다음 장에서" 할 일과 시나리오를 쓰세요.
- 뉴스 sentiment 는 코스피 전체 기준입니다. 이 종목 기준으로 다시 해석하세요(예: 환율 상승은 수출주에 꼭 악재가 아님).
- "반드시 오른다", "확실" 같은 단정은 금지. 틀릴 수 있는 이유(risks)를 꼭 쓰세요.
- 각 칸은 1~3문장. 전문용어를 쓰면 괄호로 짧게 풀어 주세요. 이모지·마크다운 금지.`;

const DRIVER_KO: Record<string, string> = {
  nvdaZ: "간밤 엔비디아 등락", soxZ: "간밤 미국 반도체지수 등락", muZ: "간밤 마이크론 등락", gapZ: "오늘 시가 갭",
  clvPrev: "어제 종가 위치(고가/저가 근처)", ocPrevZ: "어제 장중 등락", ret5Z: "최근 5일 등락", ret20Z: "한 달 추세",
  pairRel5Z: "짝 종목 대비 최근 5일", since: "시가 대비 지금", rangePos: "오늘 고가·저가 사이 위치",
};

const r0 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x));
const r2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

function validatedFacts(ctx: QuickContext): string[] {
  const ev = ctx.model.day.open.eval;
  const reg = ev.byRegime ?? {};
  const regTxt = (["vol:high", "vol:normal", "vol:calm"] as RegimeKey[])
    .filter((k) => reg[k])
    .map((k) => `${REGIME_LABEL[k]} ${reg[k].auc}`)
    .join(", ");
  return [
    `단타 모델(오늘 종가까지) 워크포워드 검증 구분력(AUC, 0.5=동전) 개장 ${ev.auc}, 장중 시간대 ${Object.entries(ctx.model.day).filter(([k]) => k !== "open").map(([k, v]) => `${k.slice(1)}시 ${v.eval.auc}`).join(" · ")} (${ev.period})`,
    "간밤 엔비디아·미국 반도체지수가 크게 오른 날은 시가가 높게 뜬 뒤 장중(시가→종가)에는 밀린 경우가 많았다 (2017~2026 매년 같은 방향). 크게 내린 날은 반대.",
    "간밤 마이크론(메모리) 상승은 반대로 장중에도 유리했다.",
    "최근 5일 급등은 장중 불리(과열 되돌림), 한 달 추세 상승은 유리(추세 지속).",
    "어제 저가 근처에서 마감했으면 오늘 장중 유리, 고가 근처 마감이면 불리했다.",
    "10시 이후에는 시가 대비 강하고 오늘 고가·저가 중 위쪽에 있을수록 종가까지 더 오른 경우가 많았다(장중 모멘텀).",
    "오후(13시 이후) 신호는 방향은 맞아도 남은 기대수익이 왕복 비용 0.18%를 넘지 못했다.",
    `국면별 개장 모델 구분력: ${regTxt} — 변동성이 큰 장에서 신호가 더 잘 맞았다.`,
    `3거래일 뒤 방향은 거의 예측되지 않았다(구분력 ${ctx.model.swing.eval.auc}).`,
    "외국인·기관 수급, 나스닥 선물·환율·코스피 장중 등락, 거래량 속도는 단타 방향 예측력을 더하지 못했다(맥락 설명용).",
  ];
}

function stockPayload(s: StockContext, ctx: QuickContext) {
  const ind = s.sig.indicators;
  const c = s.candles;
  const last20 = c.slice(-20);
  const last60 = c.slice(-60);
  const id = s.intraday;
  const live = id.available && id.isToday;
  const d = s.decision;
  return {
    ticker: s.ticker,
    name: s.name,
    price: s.sig.price,
    holding: s.holding ? { qty: s.holding.qty, avgPrice: s.holding.avgPrice, pnlPct: r2(s.sig.pnlPct) } : null,
    decision: {
      title: d.title,
      verdict: d.verdict,
      summary: d.summary,
      plan: d.plan.map((p) => `${p.label}: ${p.value}${p.hint ? ` (${p.hint})` : ""}`),
      timing: d.timing,
      cautions: d.cautions,
    },
    model: {
      checkpoint: s.pred.checkpoint,
      dayProb: r2(s.pred.dayProb),
      dayStat: d.day?.stat ?? null,
      dayDrivers: s.dayDrivers.map((x) => `${DRIVER_KO[x.name] ?? x.name}: ${x.contrib > 0 ? "오를 확률↑" : "오를 확률↓"} (${x.contrib})`),
      dayReasons: s.pred.dayReasons,
      swingProb_참고용: r2(s.pred.swingProb),
    },
    regime: { headline: s.regime.headline, lines: s.regime.lines.map((l) => `${l.label}: ${l.value} (${l.detail})`), edge: s.regime.edge?.text ?? null },
    today: live
      ? {
          open: r0(id.todayOpen), high: r0(id.todayHigh), low: r0(id.todayLow), vwap: r0(id.vwap),
          gapPct: r2(id.gapPct), rangePosPct: r0(id.rangePositionPct), distFromVwapPct: r2(id.distanceFromVwapPct),
          openingRange30m: id.openingRangeHigh ? { high: r0(id.openingRangeHigh), low: r0(id.openingRangeLow) } : null,
          orb: id.orbStatus, momentum30m: id.momentum,
        }
      : null,
    levels: {
      prevClose: r0(c[c.length - 1]?.close),
      ma5: r0(ind.ma5), ma20: r0(ind.ma20), ma60: r0(ind.ma60),
      high20: r0(Math.max(...last20.map((x) => x.high))), low20: r0(Math.min(...last20.map((x) => x.low))),
      high60: r0(Math.max(...last60.map((x) => x.high))), low60: r0(Math.min(...last60.map((x) => x.low))),
      pivotR1: r0(ind.pivotR1), pivotS1: r0(ind.pivotS1),
      stopPrice: r0(s.sig.stopPrice), breakEven: r0(s.sig.breakEvenPrice),
      range90_오늘: s.sig.volForecast?.available ? s.sig.volForecast.range90 : null,
      sigmaDailyPct: r2(s.pred.sigmaDailyPct),
    },
    indicators: { rsi14: r0(ind.rsi14), adx14: r0(ind.adx14), volumeZ: r2(ind.volumeZ), ma20SlopePct: r2(ind.ma20SlopePct) },
    recentDays: c.slice(-10).map((x) => `${x.date.slice(5)} 시${r0(x.open)} 고${r0(x.high)} 저${r0(x.low)} 종${r0(x.close)}`),
    flows10_주: s.flows.slice(-10).map((f) => `${f.d.slice(5)} 외국인${f.foreign >= 0 ? "+" : ""}${f.foreign} 기관${f.inst >= 0 ? "+" : ""}${f.inst}`),
    news: s.news.map((n) => headline(n, ctx.now)),
    disclosures_최근: s.disclosures.slice(0, 6).map((d) => `${d.date.slice(4, 6)}/${d.date.slice(6, 8)} ${d.title} (${classifyDisclosure(d.title).label})`),
    engineWarnings: s.sig.warnings.slice(0, 3),
  };
}

function ago(at: string | undefined, now: Date): string {
  if (!at) return "시각 불명";
  const m = Math.round((now.getTime() - new Date(at).getTime()) / 60_000);
  return m < 60 ? `${Math.max(0, m)}분 전` : m < 48 * 60 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
}
function headline(n: NewsItem, now: Date) {
  return {
    when: ago(n.at, now),
    source: n.source ?? null,
    topic: n.topic ?? null,
    title: n.title,
    summary: n.summary ? n.summary.slice(0, 120) : undefined,
    tone_자동: n.sentiment,
    impact: n.impact,
    breaking: n.isBreaking ?? false,
    from: n.origin === "gemini" ? "정리본" : n.origin === "disclosure" ? "공시" : "실시간",
  };
}
function topHeadlines(ctx: QuickContext) {
  const rank = (n: NewsItem) =>
    (n.isBreaking ? 100 : 0) + (n.impact === "높음" ? 30 : n.impact === "중간" ? 10 : 0) - Math.min(48, (ctx.now.getTime() - new Date(n.at ?? 0).getTime()) / 3_600_000) * 2;
  // 축마다 최소 2건은 담아 "무슨 일이 벌어지는지"의 지형이 빠지지 않게
  const items = ctx.news.filter((n) => n.topic !== "예정이벤트");
  const picked: NewsItem[] = [];
  for (const t of ["미국정책", "관세", "중국", "업황", "자사주", "실적", "금리환율", "전쟁지정학", "수급"]) {
    picked.push(...items.filter((n) => n.topic === t).sort((a, b) => rank(b) - rank(a)).slice(0, 2));
  }
  for (const n of [...items].sort((a, b) => rank(b) - rank(a))) {
    if (picked.length >= 30) break;
    if (!picked.includes(n)) picked.push(n);
  }
  return picked.slice(0, 30).map((n) => headline(n, ctx.now));
}
function digest(ctx: QuickContext) {
  const items = ctx.news.filter((n) => n.topic !== "예정이벤트");
  const by = new Map<string, { n: number; pos: number; neg: number }>();
  for (const n of items) {
    const k = String(n.topic ?? "기타");
    const v = by.get(k) ?? { n: 0, pos: 0, neg: 0 };
    v.n++;
    if (n.sentiment === "긍정") v.pos++;
    if (n.sentiment === "부정") v.neg++;
    by.set(k, v);
  }
  return {
    total: items.length,
    byTopic: [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ${v.n}건(호재 ${v.pos}·악재 ${v.neg})`).join(", "),
    sources: `실시간 네이버 ${ctx.liveFeed.counts.naver} · 구글 ${ctx.liveFeed.counts.google} · 공시 ${ctx.liveFeed.counts.disclosure} · Gemini 정리본 ${ctx.newsAgeMin != null ? `${ctx.newsAgeMin}분 전 수집` : "없음"}`,
  };
}

export function buildDeepPayload(ctx: QuickContext) {
  const m = ctx.macro;
  const pq = (q: { price: number; changePct: number } | null | undefined, d = 2) => (q ? `${Math.round(q.price * 100) / 100} (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(d)}%)` : null);
  return {
    now: `${ctx.phase.kstTime} KST`,
    phase: ctx.phase.phase,
    inSession: IN_SESSION.includes(ctx.phase.phase),
    overnightUS: {
      date: ctx.overnight.usDate,
      nvdaPct: r2(ctx.overnight.nvdaPct), soxPct: r2(ctx.overnight.soxPct), muPct: r2(ctx.overnight.muPct),
    },
    marketNow: {
      kospi: pq(m.kospi), nasdaqFutures: pq(m.nasdaqFutures), sp500Futures: pq(m.spFutures), usdkrw: pq(m.usdkrw),
      nasdaqLastClose: pq(m.nasdaq), sox: pq(m.sox), nikkei: pq(m.nikkei), shanghai: pq(m.shanghai), wti: pq(m.oil),
      vix: m.vix ? Math.round(m.vix.price * 10) / 10 : null,
      us10y: m.us10y ? Math.round(m.us10y.price * 100) / 100 : null,
      fearGreed: m.fearGreed ? `${m.fearGreed.value} (${m.fearGreed.ratingKo})` : null,
    },
    // 뉴스·공시·일정 (실시간 수집 + Gemini 정리본). tone은 자동 분류라 직접 다시 판단할 것
    newsDigest: digest(ctx),
    headlines: topHeadlines(ctx),
    upcomingEvents: ctx.news
      .filter((n) => n.topic === "예정이벤트" && Number.isFinite(n.eventInHours))
      .sort((a, b) => (a.eventInHours as number) - (b.eventInHours as number))
      .slice(0, 5)
      .map((n) => `${n.eventAt ?? ""} ${n.title} (${(n.eventInHours as number) < 0 ? "방금 발표" : `${Math.round(n.eventInHours as number)}시간 후`}, 영향 ${n.impact})`),
    newsAgeMin: ctx.newsAgeMin,
    validatedFacts: validatedFacts(ctx),
    stocks: ctx.stocks.map((s) => stockPayload(s, ctx)),
  };
}

const CONTRA_BUY = /(지금|바로|당장|9시에?)\s*(사세요|매수하세요|매수하십시오|담으세요)/;

/** 가드레일: 검증된 숫자·결론과 어긋나는 부분을 고친다 */
export function guardDeep(raw: { marketView: string; stocks: DeepStock[] }, ctx: QuickContext): DeepAnalysis {
  const inSession = IN_SESSION.includes(ctx.phase.phase);
  const out: DeepStock[] = [];
  for (const s of ctx.stocks) {
    const a = raw.stocks.find((x) => x.ticker === s.ticker);
    if (!a) continue;
    const guard: string[] = [];
    const p = s.pred.dayProb;
    const modelDir = p == null ? 0 : p >= DAY_BUY_PROB ? 1 : p <= DAY_WEAK_PROB ? -1 : 0;
    const v = s.decision.verdict;
    const verdictDir = v === "buy_now" || v === "buy_open" ? 1 : v === "stop_loss" || v === "sell_all" || v === "sell_half" ? -1 : 0;
    const aiDir = a.stance === "up" ? 1 : a.stance === "down" ? -1 : 0;
    let stance: Stance = a.stance;
    if (aiDir !== 0 && ((modelDir !== 0 && aiDir !== modelDir) || (verdictDir !== 0 && aiDir !== verdictDir))) {
      stance = "neutral";
      guard.push("AI 해석이 검증된 확률·결론과 반대 방향이라 방향 판단에서 뺐어요");
    }
    let conclusion = a.conclusion;
    if (s.decision.tone !== "buy" && CONTRA_BUY.test(conclusion)) {
      // 매수를 권하는 문장은 통째로 빼고 앱 결론을 앞에 둔다
      const kept = conclusion.split(/(?<=[.!?。])\s+/).filter((x) => !CONTRA_BUY.test(x)).join(" ");
      conclusion = `앱 결론은 "${s.decision.title}"예요 — 지금은 새로 사지 않아요.${kept ? ` ${kept}` : ""}`;
      guard.push("결론과 다른 매수 권유를 고쳤어요");
    }
    const price = s.sig.price;
    const scenarios = (a.scenarios ?? []).slice(0, 3).map((sc) => {
      let px = Number(sc.price) || 0;
      if (px > 0 && Math.abs(px / price - 1) > 0.15) {
        guard.push(`현실과 동떨어진 가격(${Math.round(px).toLocaleString("ko-KR")}원)을 뺐어요`);
        px = 0;
      }
      return { trigger: sc.trigger, price: px > 0 ? roundToTick(px, "KRW", "nearest", "KR") : 0, action: sc.action };
    });
    out.push({
      ...a,
      stance,
      conclusion,
      scenarios,
      watch: (a.watch ?? []).slice(0, 3),
      risks: (a.risks ?? []).slice(0, 2),
      guard: guard.length ? guard : undefined,
      at: { price, dayProb: p, checkpoint: s.pred.checkpoint, inSession },
    });
  }
  return {
    generatedAt: ctx.now.toISOString(),
    phase: ctx.phase.phase,
    kstTime: ctx.phase.kstTime,
    marketView: raw.marketView,
    stocks: out,
    model: MODEL,
  };
}

export async function runDeepAnalysis(ctx: QuickContext): Promise<{ analysis: DeepAnalysis | null; error: string | null; usage: AdviceUsage | null }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { analysis: null, error: "AI 키(ANTHROPIC_API_KEY)가 설정되지 않았어요. Vercel 환경변수를 확인해 주세요.", usage: null };
  if (ctx.stocks.length === 0) return { analysis: null, error: "시세를 가져오지 못해 분석할 수 없어요. 잠시 후 다시 시도해 주세요.", usage: null };
  const client = new Anthropic({ apiKey, timeout: 100_000, maxRetries: 0 });
  const payload = buildDeepPayload(ctx);
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking:
        process.env.CLAUDE_THINKING === "adaptive" || /^claude-(fable|mythos)/.test(MODEL)
          ? { type: "adaptive" as const }
          : { type: "disabled" as const },
      output_config: {
        effort: "medium" as const,
        format: { type: "json_schema" as const, schema: DEEP_SCHEMA as unknown as Record<string, unknown> },
      },
      system: [{ type: "text" as const, text: SYSTEM, cache_control: { type: "ephemeral" as const } }],
      messages: [
        {
          role: "user" as const,
          content: `지금 시점(${payload.now}, ${payload.phase}) 두 종목 심층 분석을 JSON으로 작성하세요. 각 종목의 앱 결론(decision)은 고정입니다.\n\n${JSON.stringify(payload)}`,
        },
      ],
    });
    const usage = computeUsage(MODEL, response.usage);
    if (response.stop_reason === "refusal") return { analysis: null, error: "AI가 응답을 거절했어요. 잠시 후 다시 시도해 주세요.", usage };
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return { analysis: null, error: "AI 응답 형식 오류", usage };
    let parsed: { marketView: string; stocks: DeepStock[] };
    try {
      parsed = JSON.parse(text.text);
    } catch {
      return {
        analysis: null,
        error: response.stop_reason === "max_tokens" ? "AI 응답이 길어 중간에 끊겼어요. 다시 눌러 주세요." : "AI 응답을 해석하지 못했어요. 다시 눌러 주세요.",
        usage,
      };
    }
    return { analysis: guardDeep(parsed, ctx), error: null, usage };
  } catch (e) {
    console.error("AI 심층 분석 실패:", e);
    return { analysis: null, error: describeAnthropicError(e), usage: null };
  }
}
