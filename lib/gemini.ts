// Gemini API로 실시간 뉴스/속보를 수집한다 (구글 검색 그라운딩 사용).
// GEMINI_API_KEY 필요 (https://aistudio.google.com 에서 무료 발급).
import type { NewsItem } from "./types";

const PROMPT = `당신은 한국 주식 단기 트레이더를 위한 뉴스 수집 애널리스트입니다.
구글 검색을 사용해 "지금 이 시각" 기준 최신 정보를 수집하세요. 대상:

1. 삼성전자(005930) 관련 속보/공시/실적/수주 뉴스
2. SK하이닉스(000660) 관련 속보/공시/실적/수주 뉴스 (HBM, 낸드, D램 포함)
3. 한미반도체(042700)/삼성전기(009150)/DB하이텍(000990) 관련 속보/실적/수주 뉴스
4. 반도체 업황: D램/낸드 가격, HBM 수요, 엔비디아·TSMC·마이크론 등 글로벌 테크 동향
5. 매크로: 원/달러 환율 급변동, 미국 금리/CPI, 코스피 수급(외국인/기관)
6. 파생시장: 코스피200 선물 외국인 순매수/순매도 동향, 옵션 풋콜비율, VIX·공포탐욕지수 관련 뉴스, 프로그램매매(차익/비차익) 동향
7. 지정학 리스크: 미중 갈등, 수출 규제, 전쟁/분쟁 등

최근 24시간 이내 뉴스를 우선하고, 오래된 뉴스는 제외하세요.
반드시 아래 JSON 배열 형식으로만 답하세요 (다른 텍스트 금지, 최대 14건):

[
  {
    "title": "뉴스 제목 (한국어)",
    "summary": "핵심 내용 1~2문장 (한국어)",
    "sentiment": "긍정" | "부정" | "중립",
    "impact": "높음" | "중간" | "낮음",
    "relatedTo": "삼성전자" | "SK하이닉스" | "한미반도체" | "삼성전기" | "DB하이텍" | "반도체업황" | "매크로" | "파생시장" | "지정학",
    "source": "출처 매체명",
    "publishedAt": "대략적인 시점 (예: 2시간 전, 오늘 오전)"
  }
]`;

// 구글이 모델명을 바꾸거나 특정 모델 지원을 중단해도 앱이 계속 동작하도록,
// 모델명을 코드에 고정하지 않고 매 호출 시 "현재 사용 가능한 모델 목록"에서 자동 선택한다.
// (한 번 조회한 결과는 30분간 재사용해 불필요한 API 호출을 줄인다.)
let modelCache: { name: string; expiresAt: number } | null = null;

async function resolveModel(apiKey: string): Promise<string> {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const now = Date.now();
  if (modelCache && modelCache.expiresAt > now) return modelCache.name;

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
        .filter((n) => !/vision|embedding|aqa|tts|image|thinking-exp/i.test(n));
      // 검색 그라운딩에 적합한 flash 계열을 우선 선택 (속도/비용 균형). exp/preview는 불안정하므로 후순위.
      const stableFlash = usable.find((n) => /flash/i.test(n) && !/exp|preview/i.test(n));
      const anyFlash = usable.find((n) => /flash/i.test(n));
      const picked = stableFlash ?? anyFlash ?? usable[0];
      if (picked) {
        modelCache = { name: picked, expiresAt: now + 30 * 60_000 };
        return picked;
      }
    } else {
      console.error("Gemini 모델 목록 조회 실패:", res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("Gemini 모델 목록 조회 오류:", e);
  }
  // 목록 조회 자체가 실패한 경우의 최후 대안
  return "gemini-flash-latest";
}

export async function collectNews(): Promise<{ news: NewsItem[]; error: string | null }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { news: [], error: "GEMINI_API_KEY 미설정" };
  try {
    const model = await resolveModel(apiKey);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("Gemini API 오류:", res.status, body);
      return { news: [], error: `Gemini API 오류 (${res.status}): ${body.slice(0, 200)}` };
    }
    const json = await res.json();
    const parts: { text?: string }[] = json?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("\n");
    const news = parseNewsJson(text);
    return { news, error: news.length === 0 ? "Gemini 응답에서 뉴스를 파싱하지 못했습니다" : null };
  } catch (e) {
    console.error("Gemini 뉴스 수집 실패:", e);
    return { news: [], error: `Gemini 호출 실패: ${String(e).slice(0, 200)}` };
  }
}

// /api/health 자가진단에서 사용 — 실제 뉴스 수집과 동일한 모델 해석 로직을 재사용해 결과가 서로 어긋나지 않게 한다.
export async function testGeminiConnection(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const model = await resolveModel(apiKey);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: "OK라고만 답해" }] }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true, detail: `정상 (모델: ${model})` };
    const body = await res.text().catch(() => "");
    return { ok: false, detail: `HTTP ${res.status} (모델: ${model}) ${body.slice(0, 150)}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 150) };
  }
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
      }))
      .slice(0, 12);
  } catch {
    return [];
  }
}
