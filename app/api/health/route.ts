// 자가 진단: 각 구성요소가 정상인지 한눈에 확인
// 브라우저에서 /api/health 를 열면 됩니다.
import { NextResponse } from "next/server";
import { fetchQuote } from "@/lib/market";
import { fetchLatestSnapshot } from "@/lib/snapshot";
import { testGeminiConnection } from "@/lib/gemini";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const result: Record<string, string> = {};

  // 1. 시세 수집 (야후 파이낸스)
  try {
    const q = await fetchQuote("005930.KS", "삼성전자");
    result["시세수집_야후"] = q ? `정상 (삼성전자 ${q.price.toLocaleString()}원)` : "실패 — 야후 응답 없음";
  } catch (e) {
    result["시세수집_야후"] = `오류: ${String(e).slice(0, 120)}`;
  }

  // 2. 환경변수
  result["Claude_API키"] = process.env.ANTHROPIC_API_KEY ? "설정됨" : "❌ 미설정 — Vercel 환경변수에 ANTHROPIC_API_KEY 추가 필요";
  result["Gemini_API키"] = process.env.GEMINI_API_KEY ? "설정됨" : "❌ 미설정 — Vercel 환경변수에 GEMINI_API_KEY 추가 필요";

  // 3. Claude API 실호출 테스트 (키가 있을 때만)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ timeout: 30_000, maxRetries: 0 });
      const r = await client.messages.create({
        model: process.env.CLAUDE_MODEL || "claude-opus-4-8",
        max_tokens: 16,
        messages: [{ role: "user", content: "OK라고만 답해" }],
      });
      result["Claude_호출테스트"] = r.content.length > 0 ? "정상" : "응답 비정상";
    } catch (e) {
      const msg = e instanceof Anthropic.APIError ? `${e.status} ${String(e.message).slice(0, 150)}` : String(e).slice(0, 150);
      result["Claude_호출테스트"] = `❌ 실패: ${msg}`;
    }
  }

  // 4. Gemini API 실호출 테스트 (뉴스 수집과 동일한 모델 자동선택 로직 사용)
  if (process.env.GEMINI_API_KEY) {
    const r = await testGeminiConnection(process.env.GEMINI_API_KEY);
    result["Gemini_호출테스트"] = r.ok ? r.detail : `❌ 실패: ${r.detail}`;
  }

  // 5. GitHub 자동 수집 데이터
  const snapshot = await fetchLatestSnapshot();
  result["자동수집_데이터"] = snapshot
    ? `정상 (마지막 수집: ${snapshot.collectedAt})`
    : "아직 없음 — GitHub 저장소 Settings에서 Actions 활성화 후 'Trading Agent' 워크플로를 실행하세요";

  const allOk = !Object.values(result).some((v) => v.includes("❌") || v.startsWith("오류") || v.startsWith("실패"));
  return NextResponse.json({ 종합판정: allOk ? "✅ 모든 구성요소 정상" : "⚠️ 아래 항목을 확인하세요", ...result });
}
