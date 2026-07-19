// Claude API로 최종 매매 조언을 생성한다.
// 엔진 신호(일봉+장중 기술적) + 뉴스(Gemini) + 매크로 + 포트폴리오를 종합해
// 전문 트레이더 관점의 최종 판단을 JSON으로 반환.
import Anthropic from "@anthropic-ai/sdk";
import type { AiAdvice, CollectedSnapshot, EngineSignal, MacroSnapshot, NewsItem, Portfolio } from "./types";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

const SYSTEM = `당신은 20년 경력의 한국 주식 단기(데이트레이딩) 트레이딩 전문가입니다. 고객은 약 2천만원의 실전 자금으로 삼성전자와 SK하이닉스만 단타 매매하며, 이번 거래에서 반드시 수익을 내야 하는 상황입니다. 고객은 투자 초보라 쉬운 한국어를 쓰되, 판단 자체는 프로 데이트레이더 수준으로 날카롭고 구체적이어야 합니다. "관망하세요" 한 마디로 끝내지 말고, 지금 무엇을 보고 있어야 하는지, 어떤 조건이 되면 행동해야 하는지까지 항상 제시하세요.

당신에게는 다음이 함께 주어집니다:
- 일봉 기술적 지표 (RSI, MACD, 볼린저, 20/60일선, ATR, 거래량Z점수, 52주 고저)
- 장중(분봉) 데이터: VWAP(거래량가중평균가), 갭(전일 종가 대비 시가), 오프닝레인지(개장 첫 30분 고저) 브레이크아웃 상태, 최근 30분 모멘텀, 당일 고저 범위 내 현재가 위치
- 룰 엔진이 1차 계산한 진입 트리거(entryTriggers)·무효화 조건(invalidation)·분할 매수/매도 라인(scaledEntry/scaledExit)
- 삼성전자 vs SK하이닉스 상대강도 비교
- 지금이 장의 어느 시간대인지(장초반/장중/점심시간대/마감임박 등)
- 실시간 뉴스와 과거 유사 이벤트 타임라인

트레이딩 원칙 (반드시 준수):
1. 자본 보존이 최우선. 1회 매매 손실은 총자산의 1% 이내로 제한.
2. 손절가는 진입과 동시에 확정하고, 도달 시 예외 없이 실행하도록 강조.
3. 손익비 1:2 미만인 진입은 권하지 않는다.
4. 물타기(손실 중 추가매수)는 금지. 수익 중 피라미딩만 허용.
5. 복수 근거(일봉 추세 + 장중 모멘텀/VWAP + 수급/뉴스)가 겹칠 때만 진입. 애매하면 "관망"이되, 반드시 entryTriggers에 "무엇이 확인되면 진입인지"를 구체적 가격/조건으로 명시한다.
6. 과열 구간(RSI 72+, 당일 고가권 95%+) 추격 매수는 말린다.
7. 뉴스에 고임팩트 악재가 있으면 기술적 신호보다 리스크 관리를 우선한다.
8. 장초반(09:00~09:30)·점심시간대(11:30~13:00)는 신호 신뢰도가 낮으니 이를 언급하고 신중함을 권한다.
9. 삼성전자·SK하이닉스를 동시에 보유하면 사실상 반도체 섹터 단일 베팅임을 인지시키고, 상대강도가 뚜렷하면 더 강한 쪽에 집중하라고 조언한다.
10. invalidation(무효화 조건)은 목표가·손절가와 별개로 "이 매매 논리 자체가 틀렸다"고 판단할 구체적 트리거(가격 레벨 또는 매크로 반전)로 채운다. 애매하게 쓰지 말 것.
11. 확정적 수익을 약속하지 않으며, 모든 판단은 확률적 우위에 근거함을 전제로 한다.

룰 엔진이 계산한 신호와 트리거는 1차 초안일 뿐입니다. 뉴스·매크로·장중 데이터와 교차 검증해 최종 판단하고, 엔진과 다른 결론이면 그 이유를 rationale에 명확히 설명하세요. entryTriggers와 invalidation은 룰 엔진 값을 그대로 복사하지 말고, 지금 데이터에 맞게 더 구체적으로 다듬어 작성하세요.
action은 다음 중 하나만: 신규매수, 추가매수, 보유, 부분매도, 전량매도, 손절, 관망.`;

const ADVICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overall: {
      type: "object",
      additionalProperties: false,
      properties: {
        marketComment: { type: "string" },
        riskLevel: { type: "string", enum: ["높음", "중간", "낮음"] },
        headline: { type: "string" },
        timeContext: { type: "string", description: "지금 장 시간대를 고려한 한 문장 코멘트" },
      },
      required: ["marketComment", "riskLevel", "headline", "timeContext"],
    },
    stocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ticker: { type: "string" },
          action: {
            type: "string",
            enum: ["신규매수", "추가매수", "보유", "부분매도", "전량매도", "손절", "관망"],
          },
          confidence: { type: "string", enum: ["높음", "중간", "낮음"] },
          headline: { type: "string" },
          rationale: { type: "array", items: { type: "string" } },
          targetPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
          stopPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
          checklist: { type: "array", items: { type: "string" } },
          entryTriggers: {
            type: "array",
            items: { type: "string" },
            description: "지금 당장이 아니라 '이 조건이 충족되면 진입/추가진입'하라는 구체적 가격·조건 목록. 이미 진입 신호인 경우도 어떤 조건이 지금 막 충족됐는지 명시.",
          },
          invalidation: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "목표가·손절가와 무관하게 매매 논리 자체가 무효화되는 구체적 조건",
          },
        },
        required: [
          "ticker",
          "action",
          "confidence",
          "headline",
          "rationale",
          "targetPrice",
          "stopPrice",
          "checklist",
          "entryTriggers",
          "invalidation",
        ],
      },
    },
    newsHighlights: { type: "array", items: { type: "string" } },
  },
  required: ["overall", "stocks", "newsHighlights"],
} as const;

export async function generateAdvice(params: {
  signals: EngineSignal[];
  macro: MacroSnapshot;
  news: NewsItem[];
  portfolio: Portfolio;
  history?: CollectedSnapshot | null; // 자동 수집된 직전 스냅샷 (있으면 맥락 제공)
  events?: { date: string; title: string; note: string }[]; // 과거 주요 이벤트 타임라인
}): Promise<{ advice: AiAdvice | null; error: string | null }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { advice: null, error: "ANTHROPIC_API_KEY 미설정 (Vercel 환경변수 확인 필요)" };
  // 타임아웃(ms) — 웹 요청 안에서 도는 호출이므로 재시도는 1회로 제한
  const client = new Anthropic({ apiKey, timeout: 150_000, maxRetries: 1 });

  const { signals, macro, news, portfolio } = params;

  const userContent = JSON.stringify(
    {
      현재시각_KST: new Date(Date.now() + 9 * 3600_000).toISOString().replace("Z", "+09:00"),
      장상태: signals[0]?.marketPhase ?? null,
      상대강도: signals[0]?.relativeStrengthNote ?? null,
      포트폴리오: portfolio,
      룰엔진_신호: signals.map((s) => ({
        종목: s.name,
        ticker: s.ticker,
        현재가: s.price,
        엔진판단: s.action,
        점수: s.score,
        근거: s.reasons,
        경고: s.warnings,
        목표가: s.targetPrice,
        손절가: s.stopPrice,
        제안수량: s.suggestedQty,
        수익률: s.pnlPct,
        진입트리거_엔진초안: s.entryTriggers,
        무효화조건_엔진초안: s.invalidation,
        분할매수라인: s.scaledEntry,
        분할매도라인: s.scaledExit,
        일봉지표: {
          RSI14: round1(s.indicators.rsi14),
          MA5: Math.round(s.indicators.ma5),
          MA20: Math.round(s.indicators.ma20),
          MA60: Math.round(s.indicators.ma60),
          MACD히스토그램: round1(s.indicators.macdHist),
          볼린저퍼센트B: round2(s.indicators.percentB),
          ATR14: Math.round(s.indicators.atr14),
          거래량Z점수: round2(s.indicators.volumeZ),
          "52주고가": s.indicators.high52w,
          "52주저가": s.indicators.low52w,
        },
        장중지표: s.intraday?.available
          ? {
              기준일: s.intraday.sessionDate,
              오늘데이터여부: s.intraday.isToday,
              VWAP: Math.round(s.intraday.vwap),
              VWAP대비: `${s.intraday.distanceFromVwapPct >= 0 ? "+" : ""}${s.intraday.distanceFromVwapPct.toFixed(2)}%`,
              갭: `${s.intraday.gapType} ${s.intraday.gapPct >= 0 ? "+" : ""}${s.intraday.gapPct.toFixed(2)}%`,
              당일시가: s.intraday.todayOpen,
              당일고가: s.intraday.todayHigh,
              당일저가: s.intraday.todayLow,
              당일레인지위치: `${s.intraday.rangePositionPct.toFixed(0)}%`,
              오프닝레인지: `${s.intraday.openingRangeLow ?? "-"} ~ ${s.intraday.openingRangeHigh ?? "-"}`,
              오프닝레인지상태: s.intraday.orbStatus,
              당일모멘텀: s.intraday.momentum,
            }
          : "장중 데이터 수집 실패 (일봉 기준으로만 판단)",
      })),
      매크로: {
        환율: fmtQ(macro.usdkrw),
        코스피: fmtQ(macro.kospi),
        나스닥: fmtQ(macro.nasdaq),
        필라델피아반도체: fmtQ(macro.sox),
        니케이: fmtQ(macro.nikkei),
        상해: fmtQ(macro.shanghai),
      },
      최신뉴스: news,
      직전_자동수집_요약: params.history?.aiSummary ?? null,
      과거_주요이벤트_참고: params.events ?? [],
    },
    null,
    1,
  );

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 5000,
      system: SYSTEM,
      output_config: {
        effort: "medium", // 사용자가 화면에서 기다리는 호출이므로 응답 속도 우선
        format: { type: "json_schema", schema: ADVICE_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [
        {
          role: "user",
          content: `아래 데이터를 종합해 지금 시점의 최종 매매 조언을 JSON으로 작성하세요. 단타이므로 "지금 뭘 봐야 하는지"를 반드시 구체적 가격과 조건으로 제시하세요.\n\n${userContent}`,
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      return { advice: null, error: "AI가 이 요청의 응답을 거절했습니다. 잠시 후 다시 시도해주세요." };
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return { advice: null, error: "AI 응답 형식 오류" };
    const parsed = JSON.parse(text.text) as Omit<AiAdvice, "generatedAt">;
    return { advice: { ...parsed, generatedAt: new Date().toISOString() }, error: null };
  } catch (e) {
    console.error("Claude 조언 생성 실패:", e);
    return { advice: null, error: describeAnthropicError(e) };
  }
}

function describeAnthropicError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Claude API 키가 잘못되었습니다 (401). Vercel 환경변수의 ANTHROPIC_API_KEY를 확인하세요.";
  if (e instanceof Anthropic.PermissionDeniedError) return "Claude API 키 권한 오류 (403). console.anthropic.com에서 결제 설정을 확인하세요.";
  if (e instanceof Anthropic.RateLimitError) return "Claude API 사용량 한도 초과 (429). 잠시 후 다시 시도하거나 크레딧을 확인하세요.";
  if (e instanceof Anthropic.BadRequestError) return `Claude API 요청 오류 (400): ${e.message?.slice(0, 200)}`;
  if (e instanceof Anthropic.APIConnectionError) return "Claude API 연결 실패 (네트워크/타임아웃). 다시 시도해주세요.";
  if (e instanceof Anthropic.APIError) return `Claude API 오류 (${e.status}): ${String(e.message).slice(0, 200)}`;
  return `AI 분석 중 오류: ${String(e).slice(0, 200)}`;
}

// 카카오톡/로그용 짧은 요약 텍스트 생성
export async function generateShortSummary(params: {
  signals: EngineSignal[];
  macro: MacroSnapshot;
  news: NewsItem[];
}): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system:
        "당신은 한국 주식 단타 트레이딩 전문가입니다. 삼성전자·SK하이닉스 투자자에게 보낼 짧은 브리핑을 작성하세요. 형식: 이모지 포함 8줄 이내의 순수 텍스트(마크다운 금지). 각 종목마다: 현재 상황(VWAP 위/아래, 갭 여부 포함) 한 줄 + 지금 필요한 구체적 행동(진입 트리거 또는 손절가) 한 줄. 마지막에 주요 뉴스/리스크 한 줄.",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            장상태: params.signals[0]?.marketPhase ?? null,
            신호: params.signals.map((s) => ({
              종목: s.name,
              현재가: s.price,
              판단: s.action,
              점수: s.score,
              VWAP대비: s.intraday?.available ? `${s.intraday.distanceFromVwapPct.toFixed(2)}%` : "데이터없음",
              갭: s.intraday?.available ? s.intraday.gapType : "데이터없음",
              진입트리거: s.entryTriggers.slice(0, 2),
              손절가: s.stopPrice,
              근거_상위: s.reasons.slice(0, 3),
              경고: s.warnings.slice(0, 2),
            })),
            매크로: { SOX: fmtQ(params.macro.sox), 환율: fmtQ(params.macro.usdkrw), 코스피: fmtQ(params.macro.kospi) },
            뉴스_상위: params.news.slice(0, 5).map((n) => `[${n.sentiment}/${n.impact}] ${n.title}`),
          }),
        },
      ],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((b) => b.type === "text");
    return text && text.type === "text" ? text.text : null;
  } catch (e) {
    console.error("Claude 요약 생성 실패:", e);
    return null;
  }
}

function fmtQ(q: { price: number; changePct: number } | null) {
  return q ? `${q.price.toLocaleString()} (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%)` : "정보없음";
}
function round1(v: number) {
  return Math.round(v * 10) / 10;
}
function round2(v: number) {
  return Math.round(v * 100) / 100;
}
