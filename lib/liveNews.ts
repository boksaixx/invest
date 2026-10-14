// 실시간 뉴스·공시 — 앱이 판단할 때마다 직접 가져온다 (키·AI 비용 없음, 4분 캐시).
//
// 왜 만들었나 (2026-10-14 점검)
//  · 뉴스는 GitHub Actions 자동수집(Gemini)에서만 들어왔다. 그런데 GitHub 예약 실행은 "15분마다"로 걸어 둬도
//    실제로는 하루 4~5번, 장중엔 1~2번만 돌았다(10/5~10/14 실행 이력). 장중 뉴스가 몇 시간씩 늦었다.
//  · 한 번 수집에 14개 주제를 몰아 물어 21건만 왔고, 중국·관세·예정 이벤트가 0건인 때가 있었다.
//  · 공시(DART)는 연동이 깨져 0건이었고, 앱(/api/quick)은 공시를 아예 받지 않았다.
//
// 그래서 세 갈래를 앱이 직접, 판단할 때마다 가져온다.
//  1. 네이버 증권 종목 뉴스 — 삼성전자·SK하이닉스 기사 (분 단위)
//  2. 네이버 증권 공시 — 거래소 공시 실시간 (자기주식 취득·소각, 잠정실적, 공급계약 …)
//  3. 구글 뉴스 검색 — 트럼프·관세·수출통제, 중국 반도체(CXMT·YMTC·SMIC), 메모리 가격·HBM, 금리·환율 (국내+외신)
// Gemini 수집분(요약·영향도 판단이 더 정교함)은 그대로 쓰되, 실제 발행 시각 기준 24시간이 지난 것과
// 두 종목과 무관한 기사(예전 10종목 시절 방산·금융 기사 등)는 뺀다.
//
// 정직한 한계: 여기서 붙이는 호재/악재·영향도는 제목 키워드 규칙이다(문맥은 못 읽는다). 그래서 확률 계산에는
// 넣지 않고(과거 뉴스로 검증할 방법이 없다) ① 화면 표시 ② 이벤트·쇼크 때 수량 축소 ③ AI 심층 분석의 재료로만 쓴다.
import type { DartFiling, NewsItem, NewsTopic, StockTicker } from "./types";
import { inferTopic } from "./issueMap";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const NAME: Record<string, string> = { "005930": "삼성전자", "000660": "SK하이닉스" };
const LIVE_WINDOW_H = 24;

async function getText(url: string, ms = 4500): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, cache: "no-store", signal: AbortSignal.timeout(ms) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

// ── 제목 규칙 (두 종목 = 메모리 반도체 기준. 감성은 issueMap 관례대로 "코스피 기준" 방향) ─────────────

const POS = /급등|반등|상승|강세|최고|최대|호실적|흑자|서프라이즈|상향|수주|공급\s?계약|승인|통과|인증|완화|유예|면제|철회|타결|합의|인하|자사주\s?(매입|취득)|자기주식\s?취득|소각|신고가|부족\s?(지속|심화)|가격\s?(인상|상승|반등)|surge|soar|rally|jump|record|beat|upgrade|approv|eas(e|ing)|exempt|deal|cut rates/i;
const NEG = /급락|폭락|하락|약세|쇼크|적자|부진|하향|관세.{0,12}(부과|인상|폭탄|확대)|제재|규제\s?강화|수출\s?(통제|규제|금지)|금지|보복|경고|위협|우려|압박|조사|소송|공세|저가|추격|과잉|가격\s?(하락|인하)|매도\s?폭탄|plunge|tumble|slump|slid(e|ing)|sink|fall|drop|declin|selloff|sell-off|loss|ban|curb|restrict|probe|threat|downgrade|miss|tariff hike|sanction/i;
// 중국 경쟁사의 "증설·출시·양산"은 국내 메모리에 악재 (경쟁 심화)
const CN_COMPETE = /(CXMT|YMTC|창신|창장|중국\s?메모리|중국산\s?D램|Chinese memory|China's memory).{0,40}(증설|출시|양산|진입|공세|추격|돌파|개발|예고|launch|release|mass.?produc|ramp|expand|lead|challenge|tout|claim)/i;
const HIGH = /트럼프.{0,15}(반도체|칩|관세\s?(부과|인상|폭탄))|Trump.{0,25}(chip|semiconductor)|반도체\s?관세|chip tariff|수출\s?통제|export control|쇼크|폭락|급락|급등|서프라이즈|사상\s?최대|역대\s?최대|CXMT|자사주|자기주식|소각|잠정\s?실적|HBM4|공급\s?계약|FOMC|CPI|기준금리/i;

function sentimentOf(title: string): NewsItem["sentiment"] {
  if (CN_COMPETE.test(title)) return "부정";
  const p = POS.test(title), n = NEG.test(title);
  return p && !n ? "긍정" : n && !p ? "부정" : "중립";
}
function impactOf(title: string, cluster = 1): NewsItem["impact"] {
  // "높음"은 두 종목·반도체 또는 금리 이벤트와 직접 엮인 제목만 — 트럼프 발언이라도 원전·LNG 얘기는 아니다
  const core = SEMI_WORDS.test(title) || /FOMC|CPI|기준금리|연준|Fed/i.test(title);
  if ((HIGH.test(title) && core) || cluster >= 8) return "높음";
  if (cluster >= 3 || /삼성전자|하이닉스|Samsung|Hynix|반도체|D램|HBM|메모리|chip|semiconductor|DRAM/i.test(title)) return "중간";
  return "낮음";
}
/** 제목이 어느 종목을 직접 말하나 */
function stockOf(title: string): string | null {
  const s = /삼성전자|삼전(?!닉스)|Samsung/i.test(title);
  const h = /하이닉스|Hynix/i.test(title);
  return s && !h ? "삼성전자" : h && !s ? "SK하이닉스" : null;
}
/** 두 종목 판단과 관련 있는 기사인가 (스냅샷에 남은 옛 10종목 기사 걸러내기) */
const RELEVANT_TAGS = new Set(["삼성전자", "SK하이닉스", "반도체업황", "매크로", "지수", "레버리지ETF", "파생시장", "지정학", "미국정책", "중국", "중국반도체", "자사주", "예정이벤트", "큰손동향", "실적전망"]);
const SEMI_WORDS = /반도체|메모리|D램|DRAM|낸드|HBM|삼성전자|하이닉스|Samsung|Hynix|엔비디아|Nvidia|마이크론|Micron|TSMC|CXMT|YMTC|SMIC|칩|chip/i;
export function isRelevant(n: NewsItem): boolean {
  if (RELEVANT_TAGS.has(n.relatedTo)) {
    // 자사주 태그라도 다른 회사 얘기면 뺀다 (예: "KB금융·셀트리온 자사주 소각")
    if (n.relatedTo === "자사주" && !/삼성|하이닉스|Samsung|Hynix/i.test(n.title)) return false;
    return true;
  }
  return SEMI_WORDS.test(n.title);
}

// ── 발행 시각 추정 (스냅샷 뉴스의 "3시간 전" 같은 상대 표기) ─────────────────────────────

export function estimatePublishedAt(n: NewsItem, fallbackSeenAt?: string): string | null {
  if (n.at) return n.at;
  const seen = n.seenAt ?? fallbackSeenAt;
  if (!seen) return null;
  const base = new Date(seen).getTime();
  const p = n.publishedAt ?? "";
  let m: RegExpMatchArray | null;
  if ((m = p.match(/(\d+)\s*분\s*전/))) return new Date(base - Number(m[1]) * 60_000).toISOString();
  if ((m = p.match(/(\d+)\s*시간\s*전/))) return new Date(base - Number(m[1]) * 3_600_000).toISOString();
  if ((m = p.match(/(\d+)\s*일\s*전/))) return new Date(base - Number(m[1]) * 86_400_000).toISOString();
  if (/어제/.test(p)) return new Date(base - 24 * 3_600_000).toISOString();
  if ((m = p.match(/(\d{4})[-.](\d{2})[-.](\d{2})(?:[ T](\d{2}):(\d{2}))?/))) {
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "09"}:${m[5] ?? "00"}:00+09:00`).toISOString();
  }
  return seen; // "시점 불명" — 처음 본 시각으로
}

// ── 소스별 수집 ─────────────────────────────────────────────────────────────

const kstIso = (yyyymmddhhmm: string) =>
  `${yyyymmddhhmm.slice(0, 4)}-${yyyymmddhhmm.slice(4, 6)}-${yyyymmddhhmm.slice(6, 8)}T${yyyymmddhhmm.slice(8, 10)}:${yyyymmddhhmm.slice(10, 12)}:00+09:00`;

async function naverStockNews(code: string): Promise<NewsItem[]> {
  const txt = await getText(`https://m.stock.naver.com/api/news/stock/${code}?pageSize=20&page=1`);
  if (!txt) return [];
  try {
    const clusters = JSON.parse(txt) as { total?: number; items?: Record<string, unknown>[] }[];
    return clusters
      .map((c) => ({ c, it: c.items?.[0] }))
      .filter((x): x is { c: typeof x.c; it: Record<string, unknown> } => Boolean(x.it?.title && x.it?.datetime))
      .map(({ c, it }) => {
        const title = String(it.titleFull ?? it.title).replace(/&quot;/g, '"').replace(/&amp;/g, "&");
        const cluster = Number(c.total ?? 1);
        return {
          title,
          summary: String(it.body ?? "").replace(/\s+/g, " ").slice(0, 140),
          sentiment: sentimentOf(title),
          impact: impactOf(title, cluster),
          relatedTo: stockOf(title) ?? NAME[code],
          source: String(it.officeName ?? "네이버"),
          at: new Date(kstIso(String(it.datetime))).toISOString(),
          url: it.mobileNewsUrl ? String(it.mobileNewsUrl) : undefined,
          origin: "naver" as const,
        };
      });
  } catch {
    return [];
  }
}

/** 거래소 공시 제목 → 종류·방향·영향도 (DART 수집기도 같은 규칙을 쓴다) */
export function classifyDisclosure(title: string): { topic: NewsTopic; sentiment: NewsItem["sentiment"]; impact: NewsItem["impact"]; label: string } {
  const t = title.replace(/\s+/g, "");
  if (/정정/.test(t) && !/자기주식취득|소각/.test(t)) return { topic: "기타", sentiment: "중립", impact: "낮음", label: "정정 공시" };
  if (/자기주식(취득|매입)|자사주(취득|매입)|취득신탁/.test(t)) return { topic: "자사주", sentiment: "긍정", impact: "높음", label: "자사주 매입 결정" };
  if (/주식소각|이익소각/.test(t) && !/변경상장/.test(t)) return { topic: "자사주", sentiment: "긍정", impact: "높음", label: "주식 소각 결정" };
  if (/자기주식처분/.test(t)) return { topic: "자사주", sentiment: "중립", impact: "낮음", label: "자사주 처분(임직원 보상 등)" };
  if (/잠정.?실적|영업\(잠정\)/.test(t)) return { topic: "실적", sentiment: "중립", impact: "높음", label: "잠정 실적 발표" };
  if (/유상증자|전환사채|신주인수권|교환사채/.test(t)) return { topic: "기타", sentiment: "부정", impact: "높음", label: "자금 조달(희석)" };
  if (/공급계약|판매.?계약|수주/.test(t)) return { topic: "실적", sentiment: "긍정", impact: "중간", label: "공급 계약" };
  if (/조회공시/.test(t)) return { topic: "기타", sentiment: "중립", impact: "중간", label: "조회공시" };
  if (/기업설명회|IR/.test(t)) return { topic: "예정이벤트", sentiment: "중립", impact: "중간", label: "실적 설명회 안내" };
  if (/배당/.test(t)) return { topic: "자사주", sentiment: "중립", impact: "낮음", label: "배당" };
  if (/투자|시설/.test(t)) return { topic: "업황", sentiment: "중립", impact: "중간", label: "투자 결정" };
  return { topic: "기타", sentiment: "중립", impact: "낮음", label: "기타 공시" };
}

async function naverDisclosures(code: string): Promise<{ news: NewsItem[]; filings: DartFiling[] }> {
  const txt = await getText(`https://m.stock.naver.com/api/stock/${code}/disclosure?pageSize=15&page=1`);
  if (!txt) return { news: [], filings: [] };
  try {
    const rows = JSON.parse(txt) as { title?: string; datetime?: string; disclosureId?: number }[];
    const news: NewsItem[] = [];
    const filings: DartFiling[] = [];
    for (const r of rows) {
      if (!r.title || !r.datetime) continue;
      const at = new Date(`${r.datetime}+09:00`).toISOString();
      const title = r.title.replace(/\(주\)/g, "").replace(/^에스케이하이닉스/, "SK하이닉스").trim();
      const c = classifyDisclosure(title);
      filings.push({
        title,
        date: r.datetime.slice(0, 10).replace(/-/g, ""),
        reporterName: NAME[code],
        url: `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${encodeURIComponent(NAME[code])}`,
        sentiment: c.sentiment,
      });
      news.push({
        title: `[공시] ${title}`,
        summary: c.label,
        sentiment: c.sentiment,
        impact: c.impact,
        relatedTo: NAME[code],
        topic: c.topic,
        source: "거래소 공시",
        at,
        origin: "disclosure",
      });
    }
    return { news, filings };
  } catch {
    return { news: [], filings: [] };
  }
}

type Query = { q: string; lang: "ko" | "en"; tag: string; topic: NewsTopic };
/** 구글 뉴스 검색어 — 두 종목을 움직이는 대외변수 축별 (국내 + 외신) */
export const LIVE_QUERIES: Query[] = [
  { q: "트럼프 반도체 OR 트럼프 관세 OR 트럼프 한국", lang: "ko", tag: "미국정책", topic: "미국정책" },
  { q: "반도체 관세 OR 반도체 수출통제 OR 대중 수출규제", lang: "ko", tag: "미국정책", topic: "미국정책" },
  { q: "CXMT OR YMTC OR SMIC OR 중국 메모리", lang: "ko", tag: "중국반도체", topic: "중국" },
  { q: "D램 가격 OR 메모리 가격 OR HBM 공급", lang: "ko", tag: "반도체업황", topic: "업황" },
  { q: "삼성전자 자사주 OR SK하이닉스 자사주 OR 삼성전자 소각", lang: "ko", tag: "자사주", topic: "자사주" },
  { q: "외국인 반도체 순매도 OR 외국인 삼성전자 OR 외국인 하이닉스", lang: "ko", tag: "큰손동향", topic: "수급" },
  { q: "연준 금리 OR 원달러 환율 OR 미국 국채금리", lang: "ko", tag: "매크로", topic: "금리환율" },
  { q: "Trump chips OR Trump semiconductor OR Trump tariffs Korea", lang: "en", tag: "미국정책", topic: "미국정책" },
  { q: "chip export controls China OR Nvidia China export", lang: "en", tag: "미국정책", topic: "미국정책" },
  { q: "DRAM prices OR HBM Samsung OR SK Hynix OR Micron", lang: "en", tag: "반도체업황", topic: "업황" },
];

function rssItems(xml: string): { title: string; source: string; at: string; url: string }[] {
  const out: { title: string; source: string; at: string; url: string }[] = [];
  const dec = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const title = dec(/<title>([\s\S]*?)<\/title>/.exec(it)?.[1] ?? "");
    const pub = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(it)?.[1];
    const source = dec(/<source[^>]*>([\s\S]*?)<\/source>/.exec(it)?.[1] ?? "");
    const url = dec(/<link>([\s\S]*?)<\/link>/.exec(it)?.[1] ?? "");
    if (!title || !pub) continue;
    const at = new Date(pub);
    if (Number.isNaN(at.getTime())) continue;
    // 구글 뉴스 제목 끝의 " - 언론사" 를 뗀다
    out.push({ title: source && title.endsWith(` - ${source}`) ? title.slice(0, -source.length - 3) : title, source, at: at.toISOString(), url });
  }
  return out;
}

/** 구글 검색 결과 중 두 종목 판단과 엮이는 것만 — 캐나다 철강 관세·선거 여론조사 같은 건 뺀다 */
function googleRelevant(title: string, source: string, q: Query): boolean {
  if (/블로그|blog|티스토리|카페|유튜브|youtube/i.test(source)) return false;
  if (SEMI_WORDS.test(title)) return true;
  if (q.topic === "금리환율") return /금리|환율|국채|연준|Fed|CPI|달러/i.test(title);
  if (q.topic === "수급") return /외국인|기관|순매도|순매수|코스피/.test(title);
  return /한국|Korea|코스피|KOSPI/i.test(title) && /관세|tariff|무역|trade|투자/i.test(title);
}

function titleTopic(title: string): NewsTopic | null {
  if (/CXMT|YMTC|SMIC|창신|창장|중국\s?(반도체|메모리)|Chinese (chip|memory)|China's (chip|memory)/i.test(title)) return "중국";
  if (/관세|tariff/i.test(title)) return "관세";
  if (/자사주|자기주식|소각|buyback/i.test(title)) return "자사주";
  if (/수출\s?통제|수출\s?규제|export control/i.test(title)) return "미국정책";
  return null;
}

async function googleNews(q: Query, now: Date): Promise<NewsItem[]> {
  const loc = q.lang === "ko" ? "hl=ko&gl=KR&ceid=KR:ko" : "hl=en-US&gl=US&ceid=US:en";
  const xml = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(`${q.q} when:1d`)}&${loc}`);
  if (!xml) return [];
  return rssItems(xml)
    .filter((x) => (now.getTime() - new Date(x.at).getTime()) / 3_600_000 <= LIVE_WINDOW_H && googleRelevant(x.title, x.source, q))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 6)
    .map((x) => ({
      title: x.title,
      summary: "",
      sentiment: sentimentOf(x.title),
      impact: impactOf(x.title),
      relatedTo: stockOf(x.title) ?? q.tag,
      // 검색어 축보다 제목이 말하는 축을 우선 (예: 수출통제 검색에 걸린 CXMT 기사 → 중국)
      topic: titleTopic(x.title) ?? q.topic,
      source: q.lang === "en" ? `외신 · ${x.source}` : x.source,
      at: x.at,
      url: x.url,
      origin: "google" as const,
    }));
}

// ── 묶기 ─────────────────────────────────────────────────────────────────

export interface LiveFeed {
  fetchedAt: string;
  news: NewsItem[];
  disclosures: Partial<Record<StockTicker, DartFiling[]>>;
  counts: { naver: number; google: number; disclosure: number };
  errors: string[];
}
let cache: { feed: LiveFeed; at: number } | null = null;
const TTL = 4 * 60_000;

export async function fetchLiveFeed(now: Date = new Date()): Promise<LiveFeed> {
  if (cache && now.getTime() - cache.at < TTL) return cache.feed;
  const codes = ["005930", "000660"] as const;
  const [naver, disc, google] = await Promise.all([
    Promise.all(codes.map(naverStockNews)),
    Promise.all(codes.map(naverDisclosures)),
    Promise.all(LIVE_QUERIES.map((q) => googleNews(q, now))),
  ]);
  const errors: string[] = [];
  if (naver.every((x) => x.length === 0)) errors.push("네이버 종목 뉴스 수집 실패");
  if (disc.every((x) => x.filings.length === 0)) errors.push("공시 수집 실패");
  if (google.every((x) => x.length === 0)) errors.push("구글 뉴스 수집 실패");
  const recent = (n: NewsItem) => n.at != null && (now.getTime() - new Date(n.at).getTime()) / 3_600_000 <= LIVE_WINDOW_H;
  const news = [
    ...disc.flatMap((d) => d.news).filter((n) => n.at && (now.getTime() - new Date(n.at).getTime()) / 3_600_000 <= 72), // 공시는 3일
    ...naver.flat().filter(recent),
    ...google.flat(),
  ];
  const feed: LiveFeed = {
    fetchedAt: now.toISOString(),
    news,
    disclosures: Object.fromEntries(codes.map((c, i) => [c, disc[i].filings])),
    counts: { naver: naver.flat().length, google: google.flat().length, disclosure: disc.reduce((a, d) => a + d.filings.length, 0) },
    errors,
  };
  // 전부 실패한 결과는 오래 들고 있지 않는다
  if (errors.length < 3) cache = { feed, at: now.getTime() };
  return feed;
}

function titleKey(t: string): string {
  return t.replace(/^\[공시\]\s*/, "").replace(/[\s"'“”‘’·,.…!?()[\]\-–—:;/|]/g, "").toLowerCase().slice(0, 22);
}

/**
 * 판단에 쓸 뉴스 한 묶음: Gemini 스냅샷(정리·영향도 판단) + 실시간(네이버·구글·공시) + 일정표 이벤트.
 *  · 실제 발행 시각 기준 24시간 지난 기사, 두 종목과 무관한 기사는 뺀다 (공시는 3일)
 *  · 같은 사안은 하나만 (Gemini 정리본 우선)
 *  · 속보 = 발행 3시간 이내 + 영향도 높음 (매번 지금 시각으로 다시 계산)
 */
export function buildNewsSet(params: { snapshot: NewsItem[]; snapshotSeenAt?: string | null; live: NewsItem[]; events: NewsItem[]; now?: Date }): NewsItem[] {
  const now = params.now ?? new Date();
  const ageH = (n: NewsItem) => (n.at ? (now.getTime() - new Date(n.at).getTime()) / 3_600_000 : Infinity);
  const snap = params.snapshot
    .filter(isRelevant)
    .map((n) => ({ ...n, at: estimatePublishedAt(n, params.snapshotSeenAt ?? undefined) ?? undefined, origin: n.origin ?? ("gemini" as const) }))
    .filter((n) => n.topic === "예정이벤트" || ageH(n) <= LIVE_WINDOW_H);
  const byKey = new Map<string, NewsItem>();
  for (const n of [...snap, ...params.live.filter(isRelevant)]) {
    if (n.topic === "예정이벤트" && n.origin !== "disclosure") continue; // 예정 이벤트는 일정표(아래)를 기준으로
    const k = titleKey(n.title);
    if (!byKey.has(k)) byKey.set(k, n);
  }
  const out = [...byKey.values()].map((n) => {
    const h = ageH(n);
    const topic = inferTopic(n);
    return { ...n, topic, isBreaking: n.impact === "높음" && h <= 3 };
  });
  // Gemini가 잡은 예정 이벤트 중 일정표에 없는 것(실적 발표일·관세 발효일 등)은 남은 시간을 다시 계산해 살린다
  const geminiEvents = params.snapshot
    .filter((n) => inferTopic(n) === "예정이벤트" && isRelevant(n) && Number.isFinite(n.eventInHours) && n.seenAt)
    .map((n) => ({ ...n, eventInHours: (n.eventInHours as number) - (now.getTime() - new Date(n.seenAt!).getTime()) / 3_600_000, origin: "gemini" as const }))
    .filter((n) => (n.eventInHours as number) >= -1 && !params.events.some((e) => titleKey(e.title).slice(0, 8) === titleKey(n.title).slice(0, 8)));
  return [...out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")), ...params.events, ...geminiEvents].slice(0, 120);
}

/** 화면용 뉴스 보드 — 축별 호재/악재 건수, 주요 헤드라인, 다가오는 이벤트 */
export function newsBoard(news: NewsItem[], now: Date = new Date()) {
  const items = news.filter((n) => n.topic !== "예정이벤트");
  const TOPIC_KO: Partial<Record<NewsTopic, string>> = {
    미국정책: "미국 정책", 관세: "관세", 중국: "중국", 업황: "업황", 자사주: "자사주", 실적: "실적", 금리환율: "금리·환율", 전쟁지정학: "지정학", 수급: "수급", 지수: "지수",
  };
  const topics = (Object.keys(TOPIC_KO) as NewsTopic[])
    .map((t) => {
      const xs = items.filter((n) => n.topic === t);
      return { topic: t, label: TOPIC_KO[t]!, total: xs.length, pos: xs.filter((n) => n.sentiment === "긍정").length, neg: xs.filter((n) => n.sentiment === "부정").length, breaking: xs.filter((n) => n.isBreaking).length };
    })
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total);
  const score = (n: NewsItem) => (n.isBreaking ? 100 : 0) + (n.impact === "높음" ? 30 : n.impact === "중간" ? 10 : 0) - Math.min(48, (now.getTime() - new Date(n.at ?? 0).getTime()) / 3_600_000) * 2;
  const headlines = [...items]
    .sort((a, b) => score(b) - score(a))
    .slice(0, 10)
    .map((n) => ({
      title: n.title,
      source: n.source ?? "",
      at: n.at ?? null,
      topic: TOPIC_KO[n.topic as NewsTopic] ?? "기타",
      tone: n.sentiment === "긍정" ? "pos" : n.sentiment === "부정" ? "neg" : "neu",
      breaking: n.isBreaking === true,
      url: n.url ?? null,
      origin: n.origin ?? "gemini",
    }));
  const upcoming = news
    .filter((n) => n.topic === "예정이벤트" && Number.isFinite(n.eventInHours) && (n.eventInHours as number) >= -1)
    .sort((a, b) => (a.eventInHours as number) - (b.eventInHours as number))
    .slice(0, 4)
    .map((n) => ({ title: n.title, when: n.eventAt ?? "", inHours: n.eventInHours as number, impact: n.impact }));
  return { topics, headlines, upcoming, total: items.length };
}

/** 회귀 테스트용 — 제목 하나의 자동 분류 */
export function classifyHeadline(title: string): { sentiment: NewsItem["sentiment"]; impact: NewsItem["impact"]; stock: string | null } {
  return { sentiment: sentimentOf(title), impact: impactOf(title), stock: stockOf(title) };
}
