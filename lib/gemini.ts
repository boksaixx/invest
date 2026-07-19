// Gemini API로 실시간 뉴스/속보를 수집한다 (구글 검색 그라운딩 사용).
// GEMINI_API_KEY 필요 (https://aistudio.google.com 에서 무료 발급).
import type { NewsItem } from "./types";

const PROMPT = `당신은 한국 주식 단기 트레이더를 위한 실시간 속보 수집 애널리스트입니다. 사용자는 이 정보를 보고 지금 당장 매수/매도를 결정하므로, 오래되거나 이미 다 아는 뉴스보다 "방금 나온 새로운 정보"가 훨씬 중요합니다.

구글 검색으로 아래 주제들에 대한 "지금 이 순간" 기준 최신 정보를 확인하세요. 검색 API 호출 횟수는 비용이 드니 꼭 필요한 만큼만 효율적으로 사용하고(주제가 겹치면 검색을 재사용), 결과가 부실하면 그 항목은 비워두세요:

1. 삼성전자(005930)/SK하이닉스(000660) 속보/공시/실적/수주 (HBM, 낸드, D램 포함)
2. 한미반도체(042700)/삼성전기(009150)/DB하이텍(000990)/리노공업(058470)/원익IPS(240810)/이오테크닉스(039030)/티씨케이(064760)/동진쎄미켐(005290) 속보/실적/수주
3. 반도체 업황 최신 동향: D램/낸드 가격, HBM 수요, 엔비디아·TSMC·마이크론 등 글로벌 테크 최신 뉴스
4. 매크로 실시간: 원/달러 환율 지금 시세와 급변동, 미국 금리/CPI 관련 최신 발언, 코스피 수급(외국인/기관 실시간 매매동향)
5. 파생시장 실시간: 코스피200 선물 외국인 순매수/순매도 동향, 옵션 풋콜비율, VIX·공포탐욕지수 최신값 관련 뉴스, 프로그램매매(차익/비차익) 동향
6. 지정학 리스크 속보: 미중 갈등, 반도체 수출 규제, 관세 관련 최신 발표
7. 오늘 장중 특징주/이슈: 코스피/코스닥 반도체 관련주가 지금 실제로 급등락하고 있는지

우선순위 규칙:
- 각 검색에서 가장 최근 발행 시각의 결과를 우선 채택한다. 같은 주제라도 오래된 기사보다 방금 갱신된 기사를 쓴다.
- 발행 후 3시간 이내이고 impact가 "높음"인 뉴스는 isBreaking을 true로 표시하고 배열의 맨 앞쪽에 배치한다.
- 24시간을 넘은 뉴스는 제외한다. 단, 검색 결과가 부족해 항목을 채울 수 없으면 그 사실을 요약에 짧게 남기고 비교적 최근 것으로 채운다.
- publishedAt에는 검색 결과에 나온 실제 시각/상대시각을 최대한 정확히 적는다(예: "1시간 전", "오늘 14:30", "3시간 전"). 확인 불가하면 "시점 불명"으로 적는다.

반드시 아래 JSON 배열 형식으로만 답하세요 (다른 텍스트 금지, 최대 20건, 최신순 정렬):

[
  {
    "title": "뉴스 제목 (한국어)",
    "summary": "핵심 내용 1~2문장 (한국어) — 숫자·구체적 수치가 있으면 반드시 포함",
    "sentiment": "긍정" | "부정" | "중립",
    "impact": "높음" | "중간" | "낮음",
    "relatedTo": "삼성전자" | "SK하이닉스" | "한미반도체" | "삼성전기" | "DB하이텍" | "반도체업황" | "매크로" | "파생시장" | "지정학",
    "source": "출처 매체명",
    "publishedAt": "실제 시각/상대시각",
    "isBreaking": true | false
  }
]`;

// 구글이 특정 모델의 신규 지원을 중단하거나(예: "gemini-2.5-flash is no longer available
// to new users") 계정별로 접근을 제한해도, 모델 목록 API에는 여전히 노출되는 경우가 있다.
// 즉 "목록에 있음" != "이 키로 실제 호출 가능". 그래서 한 모델만 골라 실패하면 바로 포기하지 않고,
// 최신 모델부터 순서대로 실제 호출을 시도해 처음 성공하는 모델을 쓴다.
// (뉴스 수집은 의사결정 품질에 직결되므로, 토큰 절약보다 "어떻게든 최신 모델로 풍부한 정보를 가져오는 것"을 우선한다.)
let candidateCache: { models: string[]; expiresAt: number } | null = null;
let workingModelCache: { name: string; expiresAt: number } | null = null;

function scoreModel(name: string): number {
  let score = 0;
  if (/-latest$/i.test(name)) score += 1000; // 별칭 모델은 구글이 항상 최신 버전으로 갱신해줌 → 최우선
  const verMatch = name.match(/(\d+(?:\.\d+)?)/);
  if (verMatch) score += parseFloat(verMatch[1]) * 10; // 버전 숫자가 높을수록(최신일수록) 우선
  if (/flash/i.test(name)) score += 5; // 검색 그라운딩 + 빈번한 자동수집엔 flash가 속도/할당량 면에서 안정적
  if (/pro/i.test(name)) score += 3; // pro는 후순위지만 완전히 배제하지 않음 (다른 후보가 다 실패할 때 대비)
  if (/exp|preview/i.test(name)) score -= 50; // 실험/프리뷰는 불안정하므로 후순위 (배제는 아님)
  return score;
}

async function listCandidateModels(apiKey: string): Promise<string[]> {
  const now = Date.now();
  if (candidateCache && candidateCache.expiresAt > now) return candidateCache.models;

  const fallbacks = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-pro-latest"];
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const json = await res.json();
      const models: { name: string; supportedGenerationMethods?: string[] }[] = json?.models ?? [];
      const usable = models
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .filter((n) => /gemini/i.test(n) && !/vision|embedding|aqa|tts|image|thinking-exp/i.test(n));
      const sorted = [...new Set(usable)].sort((a, b) => scoreModel(b) - scoreModel(a));
      const combined = [...sorted, ...fallbacks.filter((f) => !sorted.includes(f))];
      candidateCache = { models: combined, expiresAt: now + 30 * 60_000 };
      return combined;
    }
    console.error("Gemini 모델 목록 조회 실패:", res.status, await res.text().catch(() => ""));
  } catch (e) {
    console.error("Gemini 모델 목록 조회 오류:", e);
  }
  candidateCache = { models: fallbacks, expiresAt: now + 5 * 60_000 }; // 목록 조회 실패는 더 짧게 캐시(재시도 기회를 자주 줌)
  return fallbacks;
}

// 시도할 모델 후보 순서를 정한다. GEMINI_MODEL 환경변수가 있으면 그 모델만 고정 사용(운영자가 직접 지정한 값 존중).
async function resolveModelCandidates(apiKey: string): Promise<string[]> {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  const now = Date.now();
  // 최근에 실제로 호출 성공했던 모델이 있으면 맨 앞에 두어 불필요한 재시도를 줄인다.
  const working = workingModelCache && workingModelCache.expiresAt > now ? [workingModelCache.name] : [];
  const listed = await listCandidateModels(apiKey);
  return [...new Set([...working, ...listed])].slice(0, 6); // 시도 횟수 상한(지연시간 보호)
}

async function callGeminiGenerate(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; json: unknown } | { ok: false; status: number; body: string }> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return { ok: true, json: await res.json() };
  const text = await res.text().catch(() => "");
  return { ok: false, status: res.status, body: text };
}

// Gemini 무료 등급은 구글 검색 그라운딩 자체에 별도의(매우 빡빡한) 쿼터가 있다 — 일반 텍스트 호출은
// 성공해도 그라운딩 호출만 429(쿼터 초과)로 실패할 수 있다. 이 경우 모델을 바꿔가며 재시도해도
// 계정/쿼터 단위 문제라 대부분 똑같이 실패하고, 오히려 시도할수록 쿼터만 더 소모한다.
// 그래서 (1) 401/403/429는 즉시 재시도를 중단하고, (2) 결과를 짧게 캐시해 자동수집(15분 간격)과
// 사용자의 수동 클릭이 겹칠 때 같은 요청을 중복으로 쏘지 않도록 한다.
let newsCache: { news: NewsItem[]; error: string | null; expiresAt: number } | null = null;
const NEWS_CACHE_TTL_OK_MS = 5 * 60_000; // 성공 결과 재사용 기간
const NEWS_CACHE_TTL_FAIL_MS = 60_000; // 실패 결과도 잠깐은 캐시해 연속 재시도로 쿼터를 낭비하지 않음

function isQuotaOrAuthError(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

export async function collectNews(): Promise<{ news: NewsItem[]; error: string | null }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { news: [], error: "GEMINI_API_KEY 미설정" };

  const now = Date.now();
  if (newsCache && newsCache.expiresAt > now) return { news: newsCache.news, error: newsCache.error };

  const candidates = await resolveModelCandidates(apiKey);
  let lastError = "사용 가능한 Gemini 모델을 찾지 못했습니다";
  for (const model of candidates) {
    try {
      const result = await callGeminiGenerate(apiKey, model, {
        contents: [{ parts: [{ text: PROMPT }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      });
      if (result.ok) {
        workingModelCache = { name: model, expiresAt: Date.now() + 30 * 60_000 };
        const parts: { text?: string }[] = (result.json as any)?.candidates?.[0]?.content?.parts ?? [];
        const text = parts.map((p) => p.text ?? "").join("\n");
        const news = parseNewsJson(text);
        const error = news.length === 0 ? "Gemini 응답에서 뉴스를 파싱하지 못했습니다" : null;
        newsCache = { news, error, expiresAt: Date.now() + NEWS_CACHE_TTL_OK_MS };
        return { news, error };
      }
      lastError = `Gemini API 오류 (모델 ${model}, ${result.status}): ${result.body.slice(0, 200)}`;
      console.error(lastError);
      if (isQuotaOrAuthError(result.status)) break; // 계정/쿼터 문제 — 다른 모델도 대부분 동일하게 실패, 즉시 중단
    } catch (e) {
      lastError = `Gemini 호출 실패 (모델 ${model}): ${String(e).slice(0, 150)}`;
      console.error(lastError);
    }
  }
  newsCache = { news: [], error: lastError, expiresAt: Date.now() + NEWS_CACHE_TTL_FAIL_MS };
  return { news: [], error: lastError };
}

// /api/health 자가진단에서 사용 — 실제 뉴스 수집과 동일한 모델 해석/폴백 로직을 재사용해 결과가 서로 어긋나지 않게 한다.
export async function testGeminiConnection(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  const candidates = await resolveModelCandidates(apiKey);
  let lastDetail = "사용 가능한 Gemini 모델을 찾지 못했습니다";
  for (const model of candidates) {
    const result = await callGeminiGenerate(apiKey, model, { contents: [{ parts: [{ text: "OK라고만 답해" }] }] });
    if (result.ok) {
      workingModelCache = { name: model, expiresAt: Date.now() + 30 * 60_000 };
      return { ok: true, detail: `정상 (모델: ${model})` };
    }
    lastDetail = `HTTP ${result.status} (모델: ${model}) ${result.body.slice(0, 150)}`;
    if (isQuotaOrAuthError(result.status)) break; // 계정/쿼터 문제 — 진단 중에도 쿼터를 아낀다
  }
  return { ok: false, detail: lastDetail };
}

function parseNewsJson(text: string): NewsItem[] {
  // 응답에서 JSON 배열 부분만 관대하게 추출
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as Partial<NewsItem>[];
    return arr
      .filter((n) => n.title && n.summary)
      .map((n) => ({
        title: String(n.title),
        summary: String(n.summary),
        sentiment: (["긍정", "부정", "중립"] as const).includes(n.sentiment as never)
          ? (n.sentiment as NewsItem["sentiment"])
          : "중립",
        impact: (["높음", "중간", "낮음"] as const).includes(n.impact as never)
          ? (n.impact as NewsItem["impact"])
          : "중간",
        relatedTo: String(n.relatedTo ?? "반도체업황"),
        source: n.source ? String(n.source) : undefined,
        publishedAt: n.publishedAt ? String(n.publishedAt) : undefined,
        isBreaking: n.isBreaking === true,
      }))
      // 속보(isBreaking)를 최상단으로, 그 안에서는 원래 순서(최신순) 유지
      .sort((a, b) => Number(b.isBreaking) - Number(a.isBreaking))
      .slice(0, 20);
  } catch {
    return [];
  }
}
