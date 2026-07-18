// Gemini API로 실시간 뉴스/속보를 수집한다 (구글 검색 그라운딩 사용).
// GEMINI_API_KEY 필요 (https://aistudio.google.com 에서 무료 발급).
import type { NewsItem } from "./types";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const PROMPT = `당신은 한국 주식 단기 트레이더를 위한 뉴스 수집 애널리스트입니다.
구글 검색을 사용해 "지금 이 시각" 기준 최신 정보를 수집하세요. 대상:

1. 삼성전자(005930) 관련 속보/공시/실적/수주 뉴스
2. SK하이닉스(000660) 관련 속보/공시/실적/수주 뉴스 (HBM, 낸드, D램 포함)
3. 반도체 업황: D램/낸드 가격, HBM 수요, 엔비디아·TSMC·마이크론 등 글로벌 테크 동향
4. 매크로: 원/달러 환율 급변동, 미국 금리/CPI, 코스피 수급(외국인/기관)
5. 지정학 리스크: 미중 갈등, 수출 규제, 전쟁/분쟁 등

최근 24시간 이내 뉴스를 우선하고, 오래된 뉴스는 제외하세요.
반드시 아래 JSON 배열 형식으로만 답하세요 (다른 텍스트 금지, 최대 12건):

[
  {
    "title": "뉴스 제목 (한국어)",
    "summary": "핵심 내용 1~2문장 (한국어)",
    "sentiment": "긍정" | "부정" | "중립",
    "impact": "높음" | "중간" | "낮음",
    "relatedTo": "삼성전자" | "SK하이닉스" | "반도체업황" | "매크로" | "지정학",
    "source": "출처 매체명",
    "publishedAt": "대략적인 시점 (예: 2시간 전, 오늘 오전)"
  }
]`;

export async function collectNews(): Promise<NewsItem[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
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
      console.error("Gemini API 오류:", res.status, await res.text().catch(() => ""));
      return [];
    }
    const json = await res.json();
    const parts: { text?: string }[] = json?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("\n");
    return parseNewsJson(text);
  } catch (e) {
    console.error("Gemini 뉴스 수집 실패:", e);
    return [];
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
