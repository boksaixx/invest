// Gemini API로 실시간 뉴스/속보를 수집한다 (구글 검색 그라운딩 사용).
// GEMINI_API_KEY 필요 (https://aistudio.google.com 에서 무료 발급).
import type { NewsItem } from "./types";

const PROMPT = `한국 주식 단타 트레이더용 실시간 속보 수집. 오래된 뉴스보다 방금 나온 뉴스가 중요.

아래 주제의 "지금 이 순간" 기준 최신 정보만 구글 검색으로 확인 (주제가 겹치면 검색 재사용, 결과 없으면 지어내지 말고 생략):
1. 삼성전자(005930)/SK하이닉스(000660)/한미반도체(042700)/삼성전기(009150)/DB하이텍(000990) 속보·공시·실적
2. 반도체 업황: D램/낸드/HBM 가격·수요, 엔비디아·TSMC·마이크론 뉴스 — 로이터/블룸버그/CNBC 등 외신 원문이 있으면 국내 번역기사보다 우선 채택(번역 시차만큼 늦기 때문). 국내 기사만 있으면 그것을 쓰되 원문 시각 기준으로 판단
3. 매크로: 원/달러 환율 급변동, 미 연준(Fed) 금리/CPI 발언 — 이것도 외신 원문 발표 시각을 우선 기준으로 삼는다, 코스피 수급
4. 파생시장: 코스피200 선물 수급, VIX·공포탐욕지수
5. 레버리지/인버스 ETF(KODEX 레버리지·인버스2X 등): 수급, 괴리율·롤오버, 반대매매 이슈
6. 지정학: 미중 갈등, 반도체 수출규제·관세
7. 오늘 반도체 관련주 특징주/급등락 이슈

규칙: 최신 발행 우선. 해외발 뉴스는 국내 번역기사보다 외신 원문 발행 시각이 더 빠르므로, 같은 사안이면 원문 기준 시각으로 최신성을 판단(단 summary는 한국어로 작성). 3시간 이내+impact "높음"만 isBreaking=true, 배열 맨 앞. 24시간 초과 뉴스 제외(단 결과 부족하면 비교적 최근 것으로 채우고 그 사실을 짧게 남김). publishedAt은 실제 시각/상대시각(예: "1시간 전") 또는 "시점 불명".

summary는 숫자를 포함한 한국어 1문장(60자 이내)으로 압축. 아래 JSON 배열만 출력(다른 텍스트 금지, 최대 15건, 최신순):
[{"title":"","summary":"","sentiment":"긍정"|"부정"|"중립","impact":"높음"|"중간"|"낮음","relatedTo":"삼성전자"|"SK하이닉스"|"한미반도체"|"삼성전기"|"DB하이텍"|"반도체업황"|"매크로"|"레버리지ETF"|"파생시장"|"지정학","source":"","publishedAt":"","isBreaking":true|false}]`;

// 구글이 특정 모델의 신규 지원을 중단하거나(예: "gemini-2.5-flash is no longer available
// to new users") 계정별로 접근을 제한해도, 모델 목록 API에는 여전히 노출되는 경우가 있다.
// 즉 "목록에 있음" != "이 키로 실제 호출 가능". 그래서 한 모델만 골라 실패하면 바로 포기하지 않고,
// 최신 모델부터 순서대로 실제 호출을 시도해 처음 성공하는 모델을 쓴다.
// 비용 우선순위: flash-lite(가장 저렴) > flash > pro. pro는 토큰 단가가 flash 대비 훨씬 비싸므로,
// 버전이 아무리 최신이어도 flash 계열이 하나라도 남아있으면 절대 먼저 시도하지 않는다
// (다른 후보가 전부 실패했을 때만 쓰는 최후의 수단).
let candidateCache: { models: string[]; expiresAt: number } | null = null;
let workingModelCache: { name: string; expiresAt: number } | null = null;

function scoreModel(name: string): number {
  let familyScore = 0;
  if (/flash-lite/i.test(name)) familyScore = 3000;
  else if (/flash/i.test(name)) familyScore = 2000;
  else if (/pro/i.test(name)) familyScore = 100; // 비용이 훨씬 높아 최후순위 — 버전 보너스로도 flash를 못 넘도록 격차를 크게 둠
  let bonus = 0;
  if (/-latest$/i.test(name)) bonus += 50; // 별칭 모델은 구글이 항상 최신 버전으로 갱신해줌
  const verMatch = name.match(/(\d+(?:\.\d+)?)/);
  if (verMatch) bonus += parseFloat(verMatch[1]); // 같은 계열 내에서는 최신 버전 우선 (타이브레이커일 뿐)
  if (/exp|preview/i.test(name)) bonus -= 500; // 실험/프리뷰는 불안정하므로 후순위 (배제는 아님)
  return familyScore + bonus;
}

async function listCandidateModels(apiKey: string): Promise<string[]> {
  const now = Date.now();
  if (candidateCache && candidateCache.expiresAt > now) return candidateCache.models;

  const fallbacks = [
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-pro-latest",
  ];
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

// 구글 검색 그라운딩(google_search 툴)은 일반 텍스트 생성과 별도의 자체 쿼터를 쓴다 — 유료 결제가
// 연결된 프로젝트라도 이 쿼터는 무제한이 아니고, 프로젝트에 결제 계정이 실제로 연결·활성화되어 있지
// 않으면(구글 원/제미나이 어드밴스드 같은 개인 구독과는 별개) 여전히 무료 등급 한도로 취급된다.
// 어느 경우든 429가 뜨면 모델을 바꿔가며 재시도해도 계정/쿼터 단위 문제라 대부분 똑같이 실패하고,
// 오히려 시도할수록 쿼터만 더 소모한다. 그래서 (1) 401/403/429는 즉시 재시도를 중단하고, (2) 결과를
// 짧게 캐시해 자동수집(15분 간격)과 사용자의 수동 클릭이 겹칠 때 같은 요청을 중복으로 쏘지 않도록 한다.
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
        // maxOutputTokens: 뉴스 15건 + 검색 스니펫 근거 정도로 충분한 상한을 걸어 출력 토큰 폭주를 방지
        generationConfig: { temperature: 0.2, maxOutputTokens: 3000 },
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
      .slice(0, 15);
  } catch {
    return [];
  }
}
