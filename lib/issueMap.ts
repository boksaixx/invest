// 대외변수(자사주·중국·미국·전쟁·금리환율·관세…)를 "종목별로 어느 방향, 얼마나"로 번역한다.
//
// 왜 만들었나 (2026-09 실측):
//  · 예전 뉴스 점수(engine.newsSentimentScore)는 relatedTo가 종목명·"반도체"·"매크로"·"파생시장"일 때만
//    셌다. Gemini가 "지정학"·"지수"·"중국반도체"·"실적전망"으로 태그한 기사는 어느 종목 점수에도
//    들어가지 않았다 — 전쟁·관세·트럼프 발언이 점수에 0으로 반영됐다는 뜻이다.
//  · 반대로 "중국반도체" 기사는 relatedTo에 "반도체"가 들어 있어 KB금융·KT 점수까지 깎았다.
//  · 전쟁 뉴스는 코스피 기준 "부정"으로 태깅되는데, 방산(한화에어로스페이스)에는 반대 방향이다.
//    감성을 그대로 더하면 방산 점수를 전쟁 때 깎는다.
//
// 설계 원칙:
//  1. 뉴스 감성(sentiment)은 항상 "코스피 전체 기준"으로 통일하고(수집 프롬프트에 명시),
//     업종별 방향 뒤집기·강약은 여기 한 곳의 표에서만 한다.
//  2. 종목명이 직접 언급된 기사(자사주 매입, 실적, 수주)는 그 종목에 가중치 1.0으로 그대로 반영한다.
//  3. 점수 범위는 예전과 같은 ±15를 넘지 않는다 — 뉴스→가격 예측력은 검증된 적이 없으므로
//     (lib/newsSignal.ts 상단 주석) 영향력을 키우지 않고 "방향이 맞게" 만드는 데 그친다.
//  4. 이벤트·쇼크 오버레이는 방향 점수가 아니라 "포지션 크기"만 줄인다.
//
// 정직한 한계: 아래 민감도 표는 업종 상식에 기반한 설계값이지 실측값이 아니다. 과거 뉴스에 라벨이
// 없어 검증할 수 없다. 대신 scripts/validate-issue-map.ts 가 "전쟁 뉴스에 방산이 깎이지 않는가"
// 같은 방향 불변식을 회귀 검사한다.
import type { IssueImpact, MacroSnapshot, NewsItem, NewsTopic, RiskOverlay, StockTicker } from "./types";
import { STOCKS } from "./types";

export const NEWS_TOPICS: NewsTopic[] = ["자사주", "중국", "미국정책", "관세", "전쟁지정학", "금리환율", "실적", "업황", "수급", "지수", "예정이벤트", "기타"];

/** 업종 × 축 민감도. 부호가 음수면 "코스피 기준 방향을 뒤집는다". 0/없음이면 그 축은 이 업종 점수에 안 들어간다. */
export const SECTOR_SENSITIVITY: Record<string, Partial<Record<NewsTopic, { w: number; why: string }>>> = {
  반도체: {
    업황: { w: 1.0, why: "메모리 사이클이 곧 실적" },
    중국: { w: 1.0, why: "중국 메모리 저가 공세·수출통제가 판가와 매출에 직결" },
    미국정책: { w: 0.9, why: "수출규제·반도체법·對중 제재가 매출처와 투자에 직결" },
    관세: { w: 0.8, why: "반도체 관세·상호관세는 수출 단가에 직결" },
    전쟁지정학: { w: 0.6, why: "리스크오프 시 외국인이 가장 먼저 파는 대형 수출주" },
    금리환율: { w: 0.6, why: "기술주 할인율·외국인 수급 경유" },
    실적: { w: 0.8, why: "밸류체인(TSMC·마이크론·엔비디아) 가이던스가 선행지표" },
    수급: { w: 0.4, why: "외국인·연기금 순매수가 주가를 좌우하는 대형주" },
  },
  방산: {
    전쟁지정학: { w: -1.0, why: "긴장 고조 = 수주·예산 기대(코스피와 반대), 휴전·종전 = 기대 축소" },
    미국정책: { w: 0.4, why: "미국 국방예산·동맹 무기 수출 정책" },
    관세: { w: 0.2, why: "방산 수출은 정부 간 계약이라 관세 영향 제한적" },
    금리환율: { w: 0.2, why: "달러 수주는 원화 약세가 유리하지만 영향은 작음" },
    실적: { w: 0.3, why: "수주 잔고·인도 일정" },
    수급: { w: 0.3, why: "외국인 순매수 흐름" },
    중국: { w: 0.2, why: "직접 노출 작음(동북아 긴장 경유)" },
  },
  자동차: {
    관세: { w: 1.2, why: "미국 수출 비중이 커 관세율이 곧 마진" },
    미국정책: { w: 0.8, why: "전기차 보조금·연비 규제·對한국 정책" },
    중국: { w: 0.7, why: "중국 시장 판매와 BYD 등 중국 업체 가격 경쟁" },
    금리환율: { w: 0.5, why: "할부금리·환율(달러 매출)" },
    전쟁지정학: { w: 0.5, why: "유가·물류·러시아 등 지역 판매" },
    실적: { w: 0.3, why: "글로벌 판매 실적" },
    수급: { w: 0.3, why: "외국인 순매수 흐름" },
  },
  금융: {
    금리환율: { w: 1.0, why: "기준금리·국채금리가 예대마진·밸류에이션에 직결" },
    미국정책: { w: 0.4, why: "미 금융규제·달러 유동성" },
    전쟁지정학: { w: 0.5, why: "리스크오프 시 외국인 매도, 환율 급등" },
    관세: { w: 0.3, why: "수출 기업 여신 건전성 경유(간접)" },
    실적: { w: 0.3, why: "분기 실적·배당" },
    수급: { w: 0.4, why: "밸류업 관련 외국인·연기금 수급" },
    중국: { w: 0.2, why: "직접 노출 작음" },
  },
  바이오: {
    미국정책: { w: 0.6, why: "FDA 허가·약가 정책·바이오시밀러 대체 정책" },
    관세: { w: 0.5, why: "의약품 관세 논의" },
    금리환율: { w: 0.5, why: "성장주 할인율·달러 매출" },
    전쟁지정학: { w: 0.3, why: "리스크오프 경유(간접)" },
    실적: { w: 0.3, why: "처방 확대·허가 일정" },
    수급: { w: 0.3, why: "외국인 순매수 흐름" },
  },
  통신: {
    금리환율: { w: 0.3, why: "배당주 성격 — 금리와 역방향 경향" },
    전쟁지정학: { w: 0.2, why: "경기 방어주라 영향 작음" },
    미국정책: { w: 0.2, why: "직접 노출 작음" },
    실적: { w: 0.2, why: "요금·배당 정책" },
    수급: { w: 0.2, why: "배당 수급" },
  },
  크립토: {
    금리환율: { w: 1.0, why: "달러 유동성·연준 금리에 가장 민감한 위험자산" },
    미국정책: { w: 1.0, why: "SEC 규제·현물 ETF 승인/자금·스테이블코인 법안이 방향을 좌우" },
    전쟁지정학: { w: 0.6, why: "리스크오프 때 나스닥과 함께 빠지는 경향(디지털 금 서사는 약함)" },
    관세: { w: 0.4, why: "관세 쇼크 → 위험자산 동반 매도" },
    중국: { w: 0.3, why: "중국 채굴·거래 규제, 위안화 자본 이탈 경유" },
    수급: { w: 0.6, why: "ETF 자금 유출입·고래 지갑·거래소 유입량" },
    실적: { w: 0.2, why: "직접 실적은 없음 — 코인베이스·마이크로스트래티지 경유" },
  },
};

const TOPIC_LABEL: Record<NewsTopic, string> = {
  자사주: "자사주",
  중국: "중국",
  미국정책: "미국 정책",
  관세: "관세",
  전쟁지정학: "전쟁·지정학",
  금리환율: "금리·환율",
  실적: "실적",
  업황: "업황",
  수급: "수급",
  지수: "지수",
  예정이벤트: "예정 이벤트",
  기타: "기타",
};
export const topicLabel = (t: NewsTopic) => TOPIC_LABEL[t] ?? t;

/** 수집기가 topic을 안 붙인 기사(구버전 스냅샷)에 대해 relatedTo·제목으로 축을 추정한다 */
export function inferTopic(n: NewsItem): NewsTopic {
  if (n.topic && NEWS_TOPICS.includes(n.topic)) return n.topic;
  const title = n.title;
  // 1) 수집기의 relatedTo 태그가 시장 축을 말하면 그것을 우선 믿는다 — 제목에 "금리"·"코스피"가
  //    섞여 있어도 기사가 무엇에 관한 것인지는 태그가 더 정확하다.
  const byTag: Record<string, NewsTopic> = {
    예정이벤트: "예정이벤트",
    자사주: "자사주",
    지수: "지수",
    파생시장: "지수",
    레버리지ETF: "지수",
    중국반도체: "중국",
    중국: "중국",
    미국정책: "미국정책",
    실적전망: "실적",
    반도체업황: "업황",
    큰손동향: "수급",
    매크로: "금리환율",
    지정학: "전쟁지정학",
  };
  const tagged = byTag[n.relatedTo];
  if (tagged) {
    // 태그가 넓은 축(매크로·지정학)일 때만 제목으로 더 좁힌다 — 관세·중국·자사주·예정 이벤트는 자체 축이 있다
    if (/발표 앞두고|앞둔|예정된|D-\d|만기일/.test(title)) return "예정이벤트";
    if (/관세|tariff/i.test(title)) return "관세";
    if (tagged === "금리환율" && /전쟁|미사일|공습|중동|이란|이스라엘|우크라|대만해협|북한|휴전|종전/.test(title)) return "전쟁지정학";
    if (tagged === "금리환율" && /트럼프|백악관|수출규제|수출통제|반도체법/.test(title)) return "미국정책";
    if ((tagged === "금리환율" || tagged === "전쟁지정학") && /중국|CXMT|SMIC|YMTC|BYD|위안|희토류/.test(title)) return "중국";
    return tagged;
  }
  // 2) 종목명 태그(또는 알 수 없는 태그)면 제목으로 추정한다
  const text = `${n.relatedTo} ${title}`;
  // 가상자산 규제·ETF·자금 흐름은 미국정책/수급 축으로 — 코인 기사가 "기타"로 빠져 점수에서 사라지지 않게
  if (/SEC|현물 ETF|ETF 승인|스테이블코인|가상자산 법|디지털자산/i.test(text)) return "미국정책";
  if (/ETF 자금|ETF 유입|ETF 유출|고래|거래소 유입|김치프리미엄|청산/.test(text) && /비트코인|이더리움|리플|코인|가상자산/.test(text)) return "수급";
  if (/발표 앞두고|앞둔|예정된|D-\d|만기일/.test(text)) return "예정이벤트";
  if (/자사주|자기주식|소각|주주환원|밸류업/.test(text)) return "자사주";
  if (/관세|tariff|상호관세/i.test(text)) return "관세";
  if (/전쟁|미사일|공습|중동|이란|이스라엘|우크라|대만해협|북한|휴전|종전|지정학/.test(text)) return "전쟁지정학";
  if (/중국|CXMT|SMIC|YMTC|BYD|위안|희토류/.test(text)) return "중국";
  if (/트럼프|백악관|미 정부|미국 정부|수출규제|수출통제|반도체법|FDA/.test(text)) return "미국정책";
  if (/연준|Fed|FOMC|CPI|기준금리|국채|환율|고용보고서|한은|금통위/i.test(text)) return "금리환율";
  if (/실적|가이던스|컨센서스|목표가|어닝/.test(text)) return "실적";
  if (/D램|낸드|HBM|현물가|CAPEX|설비투자|파운드리|가동률/.test(text)) return "업황";
  if (/외국인|기관 순매수|연기금|공매도|13F/.test(text)) return "수급";
  if (/지수|코스피|나스닥|S&P|SOX|선물|VIX/.test(text)) return "지수";
  return "기타";
}

const impactWeight = (n: NewsItem) => (n.impact === "높음" ? 5 : n.impact === "중간" ? 3 : 1);

// 제목이 특정 업종 얘기임을 드러내는 패턴 — 그 업종이 아니면 이 기사는 적용하지 않는다
const SECTOR_SCOPE: { sector: string; match: RegExp }[] = [
  { sector: "반도체", match: /반도체|HBM|메모리|D램|낸드|파운드리|CXMT|SMIC|YMTC|TSMC|마이크론|엔비디아|ASML|브로드컴|AMD|인텔/i },
  { sector: "자동차", match: /BYD|전기차|자동차|완성차|배터리|테슬라/i },
  { sector: "바이오", match: /바이오|제약|FDA|임상|약가|바이오시밀러/ },
  { sector: "금융", match: /은행|금융주|예대마진|밸류업 금융/ },
  { sector: "방산", match: /방산|무기|국방예산|K-방산/ },
  { sector: "크립토", match: /비트코인|이더리움|리플|가상자산|암호화폐|스테이블코인|코인베이스|BTC|ETH|XRP|업비트|빗썸/i },
];
function scopedToOtherSector(topic: NewsTopic, title: string, sector: string): boolean {
  if (!["중국", "실적", "미국정책", "관세", "업황"].includes(topic)) return false;
  const hits = SECTOR_SCOPE.filter((s) => s.match.test(title)).map((s) => s.sector);
  return hits.length > 0 && !hits.includes(sector);
}

/** 종목명(또는 종목명의 흔한 줄임)이 기사에 직접 언급됐는가 */
function mentionsStock(n: NewsItem, ticker: StockTicker): boolean {
  const name = STOCKS[ticker].name;
  const aliases: Record<string, string[]> = {
    삼성전자: ["삼성전자", "삼전"],
    SK하이닉스: ["SK하이닉스", "하이닉스"],
    한미반도체: ["한미반도체"],
    삼성전기: ["삼성전기"],
    DB하이텍: ["DB하이텍"],
    한화에어로스페이스: ["한화에어로스페이스", "한화에어로"],
    현대차: ["현대차", "현대자동차"],
    KB금융: ["KB금융", "KB국민"],
    셀트리온: ["셀트리온"],
    KT: ["KT"],
    비트코인: ["비트코인", "BTC", "Bitcoin"],
    이더리움: ["이더리움", "ETH", "Ethereum"],
    리플: ["리플", "XRP", "Ripple"],
  };
  const keys = aliases[name] ?? [name];
  if (keys.includes(n.relatedTo)) return true;
  // 제목 매칭 — "KT"처럼 짧은 이름은 단어 경계로만 (예: "SKT"·"KT&G"에 걸리지 않게)
  return keys.some((k) => (k.length <= 2 ? new RegExp(`(^|[^A-Za-z0-9])${k}(?![A-Za-z0-9&])`).test(n.title) : n.title.includes(k)));
}

/**
 * 종목 하나에 대한 이슈 영향 목록과 뉴스 점수(±15).
 *
 * 한 기사의 기여 = 영향도(5/3/1) × 업종 민감도 |w| × (속보면 1.3) × 방향.
 * 방향 = 코스피 기준 감성 × sign(w). 종목 직접 언급 기사는 민감도 표를 거치지 않고 1.0.
 */
export function computeIssueImpacts(
  news: NewsItem[],
  ticker: StockTicker,
): { score: number; impacts: IssueImpact[]; notes: string[]; warnings: string[] } {
  const sector = STOCKS[ticker].sector;
  const table = SECTOR_SENSITIVITY[sector] ?? {};
  const contributions: { impact: IssueImpact; value: number }[] = [];

  for (const n of news) {
    const topic = inferTopic(n);
    if (topic === "예정이벤트") continue; // 아직 안 일어난 일 — 오버레이(크기 조절)로만 쓴다
    const sentiment = n.sentiment === "긍정" ? 1 : n.sentiment === "부정" ? -1 : 0;
    const direct = mentionsStock(n, ticker);
    // 지수 자체의 등락은 macroScore가 이미 숫자로 반영한다 — 종목이 직접 언급된 기사가 아니면 뺀다
    if (topic === "지수" && !direct) continue;
    // 같은 축이라도 "어느 업종 얘기인지"가 제목에 드러나면 그 업종에만 적용한다.
    // 예: "중국 CXMT HBM 경쟁"은 중국 축이지만 반도체 얘기다 — 현대차 점수를 깎으면 안 된다.
    //     "BYD 가격 인하"는 자동차 얘기다 — 삼성전자와 무관하다.
    //     "TSMC 가이던스 상향"은 반도체 밸류체인 실적이다 — 셀트리온에 호재가 아니다.
    if (!direct && scopedToOtherSector(topic, n.title, sector)) continue;
    let w: number;
    let why: string;
    if (direct) {
      w = 1.0;
      why = topic === "자사주" ? "이 종목의 자사주 매입·소각 — 수급·주주환원 직접 재료" : "이 종목이 직접 언급된 기사";
    } else {
      const cell = table[topic];
      if (!cell || cell.w === 0) continue;
      w = cell.w;
      why = cell.why;
    }
    const flipped = w < 0;
    const dir = sentiment * Math.sign(w);
    const value = impactWeight(n) * Math.abs(w) * (n.isBreaking ? 1.3 : 1) * dir;
    const strength: IssueImpact["strength"] = Math.abs(value) >= 4 ? 3 : Math.abs(value) >= 2 ? 2 : 1;
    contributions.push({
      value,
      impact: {
        topic,
        title: n.title,
        direction: dir > 0 ? "호재" : dir < 0 ? "악재" : "중립",
        strength,
        why: flipped ? `${why} (코스피 기준과 반대 방향)` : why,
        isBreaking: n.isBreaking === true,
        flipped,
      },
    });
  }

  const raw = contributions.reduce((a, c) => a + c.value, 0);
  const score = Math.max(-15, Math.min(15, Math.round(raw)));
  const impacts = contributions
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 6)
    .map((c) => c.impact);

  const notes: string[] = [];
  const warnings: string[] = [];
  const topBad = impacts.filter((i) => i.direction === "악재" && i.strength >= 2).slice(0, 2);
  const topGood = impacts.filter((i) => i.direction === "호재" && i.strength >= 2).slice(0, 2);
  for (const i of topBad) warnings.push(`${i.isBreaking ? "[속보] " : ""}악재 주의(${topicLabel(i.topic)}): ${i.title} — ${i.why}`);
  for (const i of topGood) notes.push(`${i.isBreaking ? "[속보] " : ""}호재(${topicLabel(i.topic)}): ${i.title} — ${i.why}`);
  return { score, impacts, notes, warnings };
}

/** 30시간 이내면 "이벤트 전"으로 본다 — 국내장 하루 + 미국장 밤을 덮는 길이 */
export const EVENT_RISK_HOURS = 30;
export const EVENT_SIZE_MULTIPLIER = 0.7;
export const SHOCK_SIZE_MULTIPLIER = 0.7;

/**
 * 이벤트·쇼크 오버레이 — 방향이 아니라 "얼마나"만 줄인다.
 *  · eventRisk: 30시간 내 고영향 예정 이벤트(FOMC·CPI·고용·실적발표·관세 발효 등)
 *  · shockRisk: 속보(3시간 내)이면서 고영향 악재이고 축이 전쟁·관세·미국정책·중국인 것
 *  · 상해·니케이 급변동은 점수엔 넣지 않고(검증 없음) 맥락 문장만 붙인다
 */
export function computeRiskOverlay(news: NewsItem[], macro: MacroSnapshot | null, ticker: StockTicker): RiskOverlay | null {
  const sector = STOCKS[ticker].sector;
  const notes: string[] = [];
  let mult = 1;

  // 남은 시간을 모르는 이벤트는 "임박"으로 치지 않는다(모든 고영향 예정 기사가 오버레이를 켜는 것을 막는다).
  // 이미 지난 이벤트(음수)도 제외 — 스냅샷 뉴스를 이어 쓸 때 경과분만큼 줄어든 값이 들어온다.
  const upcoming = news
    .filter((n) => inferTopic(n) === "예정이벤트" && n.impact === "높음")
    .filter((n) => Number.isFinite(n.eventInHours) && (n.eventInHours as number) >= 0 && (n.eventInHours as number) <= EVENT_RISK_HOURS)
    .slice(0, 2);
  const eventRisk = upcoming.length > 0;
  if (eventRisk) {
    mult = Math.min(mult, EVENT_SIZE_MULTIPLIER);
    const list = upcoming.map((n) => `${n.title}${n.eventAt ? `(${n.eventAt})` : n.eventInHours != null ? `(약 ${Math.round(n.eventInHours)}시간 후)` : ""}`).join(", ");
    notes.push(
      `이벤트 전 — ${list}. 발표 전후 방향은 예측되지 않으므로 신규 진입은 평소의 ${Math.round(EVENT_SIZE_MULTIPLIER * 100)}% 규모로 줄이고, 넘길 포지션은 손절 예약을 걸어두세요`,
    );
  }

  const shockTopics: NewsTopic[] = ["전쟁지정학", "관세", "미국정책", "중국"];
  const shocks = news.filter((n) => n.isBreaking && n.impact === "높음" && n.sentiment === "부정" && shockTopics.includes(inferTopic(n))).slice(0, 2);
  const shockRisk = shocks.length > 0;
  if (shockRisk) {
    mult = Math.min(mult, SHOCK_SIZE_MULTIPLIER);
    const defenseNote = sector === "방산" && shocks.some((n) => inferTopic(n) === "전쟁지정학") ? " (방산은 방향상 수혜지만 변동성은 같이 커집니다)" : "";
    notes.push(
      `쇼크 속보 — ${shocks.map((n) => `[${topicLabel(inferTopic(n))}] ${n.title}`).join(" / ")}. 헤드라인 장세에서는 첫 반응이 뒤집히는 일이 잦으니 신규 진입은 ${Math.round(SHOCK_SIZE_MULTIPLIER * 100)}% 규모, VWAP 위 안착 확인 후${defenseNote}`,
    );
  }

  if (macro) {
    const sh = macro.shanghai;
    if (sh && Math.abs(sh.changePct) >= 2 && (sector === "반도체" || sector === "자동차")) {
      notes.push(`상해종합 ${sh.changePct >= 0 ? "+" : ""}${sh.changePct.toFixed(1)}% — 중국 경기 민감 업종(${sector})은 외국인 수급이 같이 흔들릴 수 있음(점수 미반영, 맥락)`);
    }
    const nk = macro.nikkei;
    if (nk && nk.changePct <= -2.5) {
      notes.push(`니케이 ${nk.changePct.toFixed(1)}% — 아시아 동반 리스크오프 신호(점수 미반영, 맥락)`);
    }
  }

  if (!eventRisk && !shockRisk && notes.length === 0) return null;
  return { eventRisk, shockRisk, sizeMultiplier: Math.max(0.5, mult), notes };
}

/** 화면 상단 "오늘의 대외변수" 보드 — 축별 건수·방향과 예정 이벤트를 한 줄씩 */
export function computeTopicBoard(news: NewsItem[]): {
  topics: { topic: NewsTopic; label: string; total: number; positive: number; negative: number; breaking: number; pressure: number }[];
  upcoming: { title: string; when: string; impact: NewsItem["impact"] }[];
} {
  const byTopic = new Map<NewsTopic, NewsItem[]>();
  for (const n of news) {
    const t = inferTopic(n);
    byTopic.set(t, [...(byTopic.get(t) ?? []), n]);
  }
  const topics = [...byTopic.entries()]
    .filter(([t]) => t !== "예정이벤트" && t !== "기타")
    .map(([topic, items]) => {
      const positive = items.filter((n) => n.sentiment === "긍정").length;
      const negative = items.filter((n) => n.sentiment === "부정").length;
      const signed = items.reduce((a, n) => a + (n.sentiment === "긍정" ? impactWeight(n) : n.sentiment === "부정" ? -impactWeight(n) : 0), 0);
      return { topic, label: topicLabel(topic), total: items.length, positive, negative, breaking: items.filter((n) => n.isBreaking).length, pressure: Number((signed / items.length).toFixed(1)) };
    })
    .sort((a, b) => b.total - a.total);
  const upcoming = (byTopic.get("예정이벤트") ?? [])
    .slice(0, 4)
    .map((n) => ({ title: n.title, when: n.eventAt ?? (n.eventInHours != null ? `약 ${Math.round(n.eventInHours)}시간 후` : "시각 불명"), impact: n.impact }));
  return { topics, upcoming };
}
