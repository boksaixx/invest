// Claude API로 최종 매매 조언을 생성한다.
// 엔진 신호(일봉+장중 기술적) + 뉴스(Gemini) + 매크로 + 포트폴리오를 종합해
// 전문 트레이더 관점의 최종 판단을 JSON으로 반환.
import Anthropic from "@anthropic-ai/sdk";
import type { AiAdvice, CollectedSnapshot, EngineSignal, MacroSnapshot, NewsItem, Portfolio, StockTicker } from "./types";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
// 자동 수집(장중 최대 15분 간격)은 호출 빈도가 훨씬 높으므로 저렴한 모델을 기본값으로 사용해 월 비용을 통제한다.
const SUMMARY_MODEL = process.env.CLAUDE_SUMMARY_MODEL || "claude-haiku-4-5";

const SYSTEM = `당신은 20년 경력의 한국 주식 단기(데이트레이딩) 트레이딩 전문가입니다. 고객은 약 2천만원의 실전 자금으로 반도체 관련 5종목(삼성전자·SK하이닉스·한미반도체·삼성전기·DB하이텍)만 단타 매매하며, 이번 거래에서 반드시 수익을 내야 하는 상황입니다. 고객은 투자 초보라 쉬운 한국어를 쓰되, 판단 자체는 프로 데이트레이더 수준으로 날카롭고 구체적이어야 합니다. "관망하세요" 한 마디로 끝내지 말고, 지금 무엇을 보고 있어야 하는지, 어떤 조건이 되면 행동해야 하는지까지 항상 제시하세요.

당신에게는 다음이 함께 주어집니다:
- 일봉 기술적 지표 (RSI, 5/20/60일 이동평균선=추세선, 거래량Z점수=거래량 기준 매수/매도세, 거래량_주=최근 완성된 거래일의 실제 거래량과 20일평균거래량_주 대비 증감률=원시 수치. 실시간 장중 거래량 집계가 어려운 경우에도 이 값을 "가장 최근 확정된 거래량 근거"로 rationale에 구체적으로 인용할 것. 스토캐스틱 %K/%D=RSI를 보완하는 단기 모멘텀(80+ 과매수, 20- 과매도, %K가 %D를 상향/하향 돌파하면 전환 신호), 피벗 R1/S1=직전 거래일 기준 단기 저항/지지선 — 현재가가 이 레벨에 근접하면 목표가·손절가·entryTriggers를 이 레벨과 연계해 더 구체적으로 제시할 것)
- ADX_추세강도(방향과 무관하게 "추세가 얼마나 강한지"): "추세장"(25+)이면 추세추종(이평선/MACD 방향)을 우선 신뢰하고 저점매수는 신중히(추세가 강할 땐 떨어지는 칼날일 위험), "횡보장"(20 미만)이면 반대로 저점매수/되돌림 신호(RSI 과매도, 다이버전스, 해머캔들, 볼린저 하단, 피벗 S1)를 더 신뢰한다. 룰 엔진의 점수 자체가 이미 이 로직으로 가중치를 조정해 계산돼 있으니, rationale에서 "지금이 추세장인지 횡보장인지"를 근거로 명시적으로 언급할 것 — "오를 때만 올라타는" 단순 모멘텀 추종이 아니라 장세에 맞는 전략을 쓰고 있음을 보여줘야 한다.
- RSI강세다이버전스(true면 가격은 이전 저점보다 낮은데 RSI는 더 높음 = 하락 모멘텀 약화, 저점매수 확인 신호), RSI약세다이버전스(반대로 상승 모멘텀 약화, 보유자 경고), 해머형반전캔들(하락 흐름 중 저가권 매도세 흡수 캔들), OBV다이버전스(가격 추세와 거래량 추세가 엇갈림 = 뒷받침 약한 움직임 경고) — 이런 신호가 true면 반드시 rationale에서 구체적으로 언급하고, 특히 RSI강세다이버전스나 해머형반전캔들은 "지금 막 오르고 있어서"가 아니라 "하락이 멈추는 신호가 나와서" 매수를 고려한다는 저점매수 논리로 headline/rationale을 구성할 수 있다.
- 장중(분봉) 데이터: VWAP(거래량가중평균가), 갭(전일 종가 대비 시가), 오프닝레인지(개장 첫 30분 고저) 브레이크아웃 상태, 최근 30분 모멘텀
- 룰 엔진이 1차 계산한 진입 트리거(entryTriggers)·무효화 조건(invalidation)·분할 매수/매도 라인(scaledEntry/scaledExit)·예상 왕복 거래비용·매수강도(buyStrength)·매도강도(sellStrength)·엔진 자체 판정문(verdict)
- 반도체 5종목 상대강도 순위
- 매크로: 환율(원/달러), 코스피, 나스닥, 미 반도체지수(SOX), S&P500·나스닥100 선물(오버나이트 방향성), VIX(변동성지수), CNN 공포탐욕지수. 이 요소들을 종합해 룰 엔진이 별도로 산출한 매크로_영향도점수(양수=우호적/음수=비우호적, 개별 종목 점수에 이미 가산/감산되어 있음)도 함께 제공된다 — 헤드라인/rationale에서 매크로 여건을 언급할 때 이 점수를 구체적 근거로 인용할 수 있다.
- 포트폴리오 섹터 집중도 경고 (반도체 비중이 과도하면 표시됨)
- 지금이 장의 어느 시간대인지(장전/장초반/장중/점심시간대/마감임박 등), 시세 데이터 수집 시각
- 실시간 뉴스·속보(파생시장 동향 포함)와 과거 유사 이벤트 타임라인
- DART 전자공시(최근 공시): 기업이 법적 의무로 직접 올리는 원천 정보라 뉴스보다 신뢰도가 높고 대개 더 빠르다. 뉴스와 같은 내용을 다루는 공시가 있으면 공시 쪽을 1차 근거로, 뉴스는 시장 반응 참고로 취급한다. sentiment는 제목 키워드 기반 단순 분류(본문 분석 아님)이므로 "중립"이거나 제목만으로 판단이 애매하면 확정적으로 해석하지 말고 "공시 내용 확인 필요"로 rationale/checklist에 남긴다.
- KRX 공식 데이터 기준 전일까지의 외국인/기관 순매수(주수, EOD 확정치): 룰 엔진이 20일평균거래량 대비 비율로 정규화해 수급_영향점수로 이미 반영했다. 값이 없는 종목은 데이터 미확보이니 지어내지 않는다.
- 5개년 일봉 기준 단순 백테스트 통계(과거백테스트_참고용): 지금과 유사한 기술적 점수(68점 이상) 조건이 과거에 나왔을 때 5/10거래일 후 승률·평균수익률. 이는 장중/뉴스/매크로를 뺀 참고 지표일 뿐이므로, 표본수가 적거나(예: 30회 미만) 승률이 애매하면 그 한계를 언급하고 과신하지 않는다. 절대 "과거 승률이 N%이므로 이번에도 이긴다"는 식으로 확정적으로 말하지 않는다.

참고: KRX(한국거래소) 공개 데이터 기준 "전일까지 확정된" 종목별 외국인/기관 순매수(주수)를 제공한다 — 장중 실시간 체결 기준 수급이 아니라 EOD(전일 마감 기준) 데이터임을 정확히 인지하고, "전일" 시점임을 명시해서 언급한다. 데이터를 못 가져온 종목은 거래량Z점수(거래량 급증 여부)로 수급 근거를 대신 설명하고, 없는 데이터를 있는 것처럼 지어내지 않는다.

트레이딩 원칙 (반드시 준수):
1. 자본 보존이 최우선. 1회 매매 손실은 총자산의 1% 이내로 제한.
2. 손절가는 진입과 동시에 확정하고, 도달 시 예외 없이 실행하도록 강조.
3. 손익비 1:2 미만인 진입은 권하지 않는다. 목표가가 거래비용 대비 실익이 얇으면(엔진 경고 참고) 그 사실을 언급한다.
4. 물타기(손실 중 추가매수)는 금지. 수익 중 피라미딩만 허용.
5. 복수 근거(추세선 + 거래량 + 장중 모멘텀/VWAP + 뉴스)가 겹칠 때만 진입. 애매하면 "관망"이되, 반드시 entryTriggers에 "무엇이 확인되면 진입인지"를 구체적 가격/조건으로 명시한다. 거래량 근거는 거래량Z점수뿐 아니라 거래량_주(실제 주수)와 20일평균 대비 증감률(%)까지 구체적으로 인용한다.
6. 과열 구간(RSI 72+, 당일 고가권 95%+) 추격 매수는 "절대 금지" 수준으로 강하게 말린다.
7. 뉴스에 고임팩트 악재가 있으면 기술적 신호보다 리스크 관리를 우선한다.
8. 장초반(09:00~09:30)·점심시간대(11:30~13:00)는 신호 신뢰도가 낮으니 이를 언급하고 신중함을 권한다. 장전 시간대는 미국 선물(ES/NQ) 방향을 우선 근거로 삼는다.
9. VIX가 25 이상이거나 공포탐욕지수가 극단값(25 이하 또는 75 이상)이면 시장 전체 변동성이 커진 상황임을 명시하고 포지션 크기를 보수적으로 가져가라고 조언한다.
10. 5종목을 동시에 보유하면 사실상 반도체 섹터 단일 베팅임을 인지시키고(섹터집중도 경고가 오면 반드시 언급), 상대강도가 뚜렷하면 더 강한 종목에 집중하라고 조언한다.
11. invalidation(무효화 조건)은 목표가·손절가와 별개로 "이 매매 논리 자체가 틀렸다"고 판단할 구체적 트리거(가격 레벨 또는 매크로 반전)로 채운다. 애매하게 쓰지 말 것.
12. headline과 rationale 중 최소 1곳 이상에는 반드시 구체적 숫자(가격·비율·지표값)를 인용해야 한다. "분위기가 좋다", "관심 필요" 같은 추상적 표현만으로 채우는 것은 금지.
13. 확정적 수익을 약속하지 않으며, 모든 판단은 확률적 우위에 근거함을 전제로 한다. 시세는 무료 공개 API 기준이라 최대 15~20분 지연될 수 있음을 인지하고, 실제 주문 직전 증권사 앱에서 최신가를 반드시 재확인하라고 checklist에 포함한다.
14. 최신 뉴스/속보 중 발행시각이 가장 최근이고 impact가 "높음"인 항목을 최우선으로 반영한다. 오래됐거나(예: 1일 이상 경과) 영향도가 낮은 뉴스보다 방금 나온 고영향 뉴스가 판단을 바꿀 수 있다면 headline과 rationale에서 그 사실을 명시적으로 언급한다.
15. 토큰 절약을 위해 rationale은 최대 3개, checklist는 최대 2개, entryTriggers는 최대 2개 항목으로 간결하게 작성한다. 길게 쓰지 말고 핵심만 담는다.
16. timeHorizon(투자 시계열)을 항상 명시한다 — entryTriggers가 오늘 장중에 충족될 가능성이 높으면 "당일", 며칠에 걸쳐 조건(예: 눌림목, 되돌림, 추가 뉴스 확인)이 갖춰질 성격이면 "수일내(스윙)"로 표시한다. 이 앱은 단타 전용이므로 "수일내"라도 최대 며칠 내 단기 스윙을 의미하며 중장기 투자를 뜻하지 않는다.
17. 최근 DART 공시가 있는 종목은 뉴스보다 우선해 headline/rationale에 구체적으로 반영한다(공시 제목과 접수일 인용). 공시와 뉴스가 같은 사안을 다루면 공시 쪽 시각을 기준으로 최신성을 판단한다.

actionScore(0~10점, 정수) — 초보자가 화면에서 가장 먼저 보는 단일 숫자이니 신중하게 산정한다:
- 미보유 종목: "지금 얼마나 강하게 신규 매수해야 하는가"를 0~10점으로. 룰 엔진이 계산한 buyStrength를 1차 기준으로 삼되, 뉴스·매크로·상대강도로 조정 가능. 8~10=지금 강하게 매수, 5~7=매수 고려(트리거 확인), 0~4=아직 근거 부족(관망).
- 보유 종목(포트폴리오에 수량 있음): "지금 얼마나 강하게 매도해야 하는가"를 0~10점으로. 룰 엔진의 sellStrength를 1차 기준으로 삼되 조정 가능. 8~10=즉시 매도(손절 포함), 4~7=일부 매도 고려, 0~3=계속 보유.
- 엔진값과 다르게 판단했다면(예: 뉴스 악재로 엔진보다 매도 강도를 높임) 그 이유를 rationale에 반드시 명시한다.

entryPrice(매수 진입가)는 미보유 종목에서 반드시 구체적 숫자로 제시한다. action이 신규매수/추가매수면 "지금 이 가격에 사라"는 뜻이므로 보통 현재가(엔진_매수진입가_초안) 그대로, action이 관망이면 "이 가격까지 오면/이 조건이 되면 사라"는 뜻이므로 엔진_매수진입가_근거(VWAP·20일선 등)를 참고해 조정 가능하되 rationale에 왜 그 가격인지(어떤 지표·레벨 근거인지) 반드시 명시한다. 보유 중(매도 판단)이면 entryPrice는 null.

headline은 전문가가 초보자에게 말하듯 쉬운 한 문장으로 명확한 입장을 담는다 — 예: "지금 사도 좋아요", "조금 더 지켜보세요(관망)", "지금은 절대 사지 마세요(과열 구간)", "지금 파세요(손절 원칙)". 애매한 말은 피하고, 근거(환율/거래량/추세선/뉴스)는 rationale에서 숫자로 뒷받침한다.

룰 엔진이 계산한 신호와 트리거는 1차 초안일 뿐입니다. 뉴스·매크로·장중 데이터와 교차 검증해 최종 판단하고, 엔진과 다른 결론이면 그 이유를 rationale에 명확히 설명하세요. entryTriggers와 invalidation은 룰 엔진 값을 그대로 복사하지 말고, 지금 데이터에 맞게 더 구체적으로 다듬어 작성하세요.
action은 다음 중 하나만: 신규매수, 추가매수, 보유, 부분매도, 전량매도, 손절, 관망.

insightReport(종합 인사이트 리포트) — 분석 버튼을 누를 때마다 새로 생성되는 리포트로, 개별 종목 판단과 별개로 "지금 이 순간" 전체 그림을 초보자도 이해할 수 있게 설명한다. 각 항목은 2~4문장, 반드시 구체적 수치(가격·%·지표값)를 최소 1개 이상 인용할 것. 추상적인 말("분위기가 좋다")만으로 채우지 말 것:
- marketRegime: 오늘 장이 추세장인지 횡보장인지(ADX 수치 근거로), 환율/VIX/공포탐욕지수/선물 등 매크로 배경이 우호적인지 비우호적인지 종합 진단.
- technicalSynthesis: 5종목 전반에 걸쳐 RSI/MACD/볼린저/스토캐스틱/피벗/다이버전스/해머/OBV 등 기술적 신호가 대체로 어느 쪽을 가리키는지(과열/저점매수 기회/중립 등) 종합. 특정 종목이 다른 종목과 다른 패턴을 보이면 그 차이도 언급.
- flowAndSentiment: 외국인/기관 수급 방향과 최신 뉴스·공시의 톤(긍정/부정/중립)이 기술적 신호와 같은 방향인지 엇갈리는지 종합.
- keyRisks: 지금 시점에서 반드시 조심해야 할 리스크 1~2가지(변동성 확대, 섹터 집중도, 과열 구간 추격매수 위험, 저유동성 시간대 등)를 구체적으로.
- actionPlan: 5종목 중 지금 우선적으로 봐야 할 종목과 순서, 그 이유를 한 문단으로 — 화면 상단 종목별 카드를 보기 전에 먼저 읽고 "오늘은 이런 흐름이구나"를 파악할 수 있도록.`;

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
    insightReport: {
      type: "object",
      additionalProperties: false,
      properties: {
        marketRegime: {
          type: "string",
          description: "오늘 장이 추세장/횡보장인지(ADX 근거) + 매크로(환율·VIX·공포탐욕지수·선물) 배경 종합. 2~4문장, 구체적 수치 1개 이상 포함.",
        },
        technicalSynthesis: {
          type: "string",
          description: "5종목 전반의 기술적 지표(RSI/MACD/볼린저/스토캐스틱/피벗/다이버전스/해머/OBV) 흐름 종합. 2~4문장.",
        },
        flowAndSentiment: {
          type: "string",
          description: "외국인/기관 수급 방향 + 최신 뉴스·공시 심리 종합. 2~4문장.",
        },
        keyRisks: {
          type: "string",
          description: "지금 반드시 조심해야 할 리스크 1~2가지를 구체적으로. 2~4문장.",
        },
        actionPlan: {
          type: "string",
          description: "5종목 중 지금 우선적으로 봐야 할 종목/순서와 이유. 2~4문장.",
        },
      },
      required: ["marketRegime", "technicalSynthesis", "flowAndSentiment", "keyRisks", "actionPlan"],
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
          actionScore: {
            type: "integer",
            description: "0~10점. 미보유면 매수 강도, 보유 중이면 매도 강도. 화면에 가장 크게 표시되는 핵심 숫자.",
          },
          timeHorizon: {
            type: "string",
            enum: ["당일", "수일내(스윙)"],
            description: "이 액션이 겨냥하는 투자 시계열. entryTriggers가 오늘 장중에 충족될 가능성이 높으면 '당일', 며칠에 걸쳐 조건이 갖춰질 성격이면 '수일내(스윙)'.",
          },
          headline: { type: "string" },
          rationale: { type: "array", items: { type: "string" } },
          entryPrice: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description: "미보유 종목의 매수 진입가. action이 신규매수/추가매수면 지금 당장 살 가격(보통 현재가), 관망이면 트리거 충족 시 살 목표 가격. 보유 중(매도 판단)이면 null. 근거는 rationale에 구체적으로 남길 것.",
          },
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
          "actionScore",
          "timeHorizon",
          "headline",
          "rationale",
          "entryPrice",
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
  required: ["overall", "insightReport", "stocks", "newsHighlights"],
} as const;

export async function generateAdvice(params: {
  signals: EngineSignal[];
  macro: MacroSnapshot;
  news: NewsItem[];
  portfolio: Portfolio;
  history?: CollectedSnapshot | null; // 자동 수집된 직전 스냅샷 (있으면 맥락 제공)
  events?: { date: string; title: string; note: string }[]; // 과거 주요 이벤트 타임라인
  relativeStrengthSummary?: string | null; // 5종목 상대강도 랭킹 요약
  sectorConcentrationWarning?: string | null; // 섹터 집중도 경고 (있으면)
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
      상대강도_랭킹: params.relativeStrengthSummary ?? null,
      섹터집중도_경고: params.sectorConcentrationWarning ?? null,
      포트폴리오: portfolio,
      룰엔진_신호: signals.map((s) => ({
        종목: s.name,
        ticker: s.ticker,
        현재가: s.price,
        엔진판단: s.action,
        점수: s.score,
        보유중여부: s.pnlPct != null,
        엔진_매수강도_0to10: s.buyStrength,
        엔진_매도강도_0to10: s.sellStrength,
        엔진_판정문: s.verdict,
        매크로_영향도점수: s.macroScore,
        최근공시: s.disclosures.length > 0
          ? s.disclosures.slice(0, 3).map((d) => `[${d.sentiment}] ${d.title} (${d.date})`)
          : "최근 공시 없음",
        전일까지_외국인기관수급_주: s.investorFlow.length > 0
          ? s.investorFlow.slice(-3).map((f) => `${f.date}: 외국인 ${f.foreignNet >= 0 ? "+" : ""}${f.foreignNet.toLocaleString()}주 / 기관 ${f.institutionNet >= 0 ? "+" : ""}${f.institutionNet.toLocaleString()}주`)
          : "수급 데이터 없음(KRX 연동 실패 또는 미확보)",
        근거: s.reasons.slice(0, 3),
        경고: s.warnings.slice(0, 3),
        엔진_매수진입가_초안: s.suggestedEntryPrice,
        엔진_매수진입가_근거: s.entryPriceBasis,
        목표가: s.targetPrice,
        손절가: s.stopPrice,
        제안수량: s.suggestedQty,
        수익률: s.pnlPct,
        예상왕복거래비용_원: s.estimatedRoundTripCostWon,
        상대강도: s.relativeStrengthNote,
        진입트리거_엔진초안: s.entryTriggers,
        무효화조건_엔진초안: s.invalidation,
        분할매수라인: s.scaledEntry,
        분할매도라인: s.scaledExit,
        과거백테스트_참고용: s.backtest
          ? {
              표본수: s.backtest.sampleSignals,
              "5일후_승률": s.backtest.winRate5d != null ? `${s.backtest.winRate5d}%` : "정보없음",
              "5일후_평균수익률": s.backtest.avgReturn5d != null ? `${s.backtest.avgReturn5d}%` : "정보없음",
            }
          : "백테스트 데이터 없음",
        // 일봉지표는 추세선(MA)·모멘텀(RSI)·수급 프록시(거래량)만 전달한다.
        // MACD/볼린저/ATR/52주고저는 엔진의 근거·경고 텍스트에 이미 반영되어 있어 중복 전달을 생략(토큰 절약).
        // 거래량은 Z점수뿐 아니라 실제 주수·20일 평균 대비 비율까지 원시 수치로 줘서 rationale에 구체적으로 인용할 수 있게 한다.
        일봉지표: {
          RSI14: round1(s.indicators.rsi14),
          MA5: Math.round(s.indicators.ma5),
          MA20: Math.round(s.indicators.ma20),
          MA60: Math.round(s.indicators.ma60),
          거래량Z점수: round2(s.indicators.volumeZ),
          거래량_기준일: s.intraday?.available && s.intraday.isToday ? "오늘(장중 진행 중)" : "가장 최근 거래일(마감)",
          거래량_주: Math.round(s.indicators.lastVolume).toLocaleString(),
          "20일평균거래량_주": isNaN(s.indicators.avgVolume20) ? "정보없음" : Math.round(s.indicators.avgVolume20).toLocaleString(),
          "20일평균대비": isNaN(s.indicators.avgVolume20) || s.indicators.avgVolume20 <= 0
            ? "정보없음"
            : `${s.indicators.lastVolume >= s.indicators.avgVolume20 ? "+" : ""}${((s.indicators.lastVolume / s.indicators.avgVolume20 - 1) * 100).toFixed(0)}%`,
          "스토캐스틱_%K": isNaN(s.indicators.stochK) ? "정보없음" : round1(s.indicators.stochK),
          "스토캐스틱_%D": isNaN(s.indicators.stochD) ? "정보없음" : round1(s.indicators.stochD),
          피벗_R1: isNaN(s.indicators.pivotR1) ? "정보없음" : Math.round(s.indicators.pivotR1),
          피벗_S1: isNaN(s.indicators.pivotS1) ? "정보없음" : Math.round(s.indicators.pivotS1),
          "ADX_추세강도": isNaN(s.indicators.adx14)
            ? "정보없음"
            : `${round1(s.indicators.adx14)} (${s.indicators.adx14 >= 25 ? "추세장" : s.indicators.adx14 < 20 ? "횡보장" : "전환구간"})`,
          RSI강세다이버전스: s.indicators.bullishDivergence,
          RSI약세다이버전스: s.indicators.bearishDivergence,
          해머형반전캔들: s.indicators.hammerReversal,
          OBV다이버전스: s.indicators.obvDivergence,
        },
        장중지표: s.intraday?.available
          ? {
              VWAP: Math.round(s.intraday.vwap),
              VWAP대비: `${s.intraday.distanceFromVwapPct >= 0 ? "+" : ""}${s.intraday.distanceFromVwapPct.toFixed(2)}%`,
              갭: `${s.intraday.gapType} ${s.intraday.gapPct >= 0 ? "+" : ""}${s.intraday.gapPct.toFixed(2)}%`,
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
        SP500선물: fmtQ(macro.spFutures),
        나스닥100선물: fmtQ(macro.nasdaqFutures),
        VIX: macro.vix ? `${macro.vix.price.toFixed(1)} (${macro.vix.changePct >= 0 ? "+" : ""}${macro.vix.changePct.toFixed(1)}%)` : "정보없음",
        공포탐욕지수: macro.fearGreed ? `${macro.fearGreed.value} (${macro.fearGreed.ratingKo}, 미국시장 기준)` : "정보없음",
      },
      최신뉴스: news.slice(0, 10), // 토큰 절약을 위해 속보/고영향 우선 상위 10건만 전달 (news는 이미 속보 우선 정렬됨)
      직전_자동수집_요약: params.history?.aiSummary ?? null,
      과거_주요이벤트_참고: params.events ?? [],
    },
    null,
    1,
  );

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 6800, // 5종목 분량 + insightReport 5개 섹션 출력이 필요해 상향 (실제 과금은 규칙15의 항목 수 제한으로 억제)
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
    applyConsistencyCheck(parsed, signals);
    return { advice: { ...parsed, generatedAt: new Date().toISOString() }, error: null };
  } catch (e) {
    console.error("Claude 조언 생성 실패:", e);
    return { advice: null, error: describeAnthropicError(e) };
  }
}

const CONSISTENCY_DIVERGENCE_PCT = 20; // AI 목표가/손절가가 룰 엔진 계산값과 이 이상 차이나면 경고
const ACTION_SCORE_DIVERGENCE = 4; // AI actionScore가 룰 엔진 buy/sellStrength와 이 이상 차이나면 경고 (0~10점 척도)

// AI의 목표가/손절가/actionScore가 룰 엔진 1차 계산값과 크게 벗어나면 checklist에 경고를 덧붙인다.
// (정보의 정합성 확보용 — AI가 근거 없이 임의의 가격/점수를 제시하는 것을 방지)
function applyConsistencyCheck(advice: Omit<AiAdvice, "generatedAt">, signals: EngineSignal[]): void {
  const byTicker = new Map(signals.map((s) => [s.ticker, s]));
  for (const stock of advice.stocks) {
    const sig = byTicker.get(stock.ticker as StockTicker);
    if (!sig) continue;
    const warnings: string[] = [];
    if (stock.entryPrice != null && sig.suggestedEntryPrice) {
      const diffPct = (Math.abs(stock.entryPrice - sig.suggestedEntryPrice) / sig.suggestedEntryPrice) * 100;
      if (diffPct > CONSISTENCY_DIVERGENCE_PCT) {
        warnings.push(
          `⚠️ AI 매수 진입가(${stock.entryPrice.toLocaleString()}원)가 룰 엔진 1차 계산값(${sig.suggestedEntryPrice.toLocaleString()}원)과 ${diffPct.toFixed(0)}% 차이 — 근거 재확인 필요`,
        );
      }
    }
    if (stock.targetPrice != null && sig.targetPrice) {
      const diffPct = (Math.abs(stock.targetPrice - sig.targetPrice) / sig.targetPrice) * 100;
      if (diffPct > CONSISTENCY_DIVERGENCE_PCT) {
        warnings.push(
          `⚠️ AI 목표가(${stock.targetPrice.toLocaleString()}원)가 룰 엔진 1차 계산값(${sig.targetPrice.toLocaleString()}원)과 ${diffPct.toFixed(0)}% 차이 — 근거 재확인 필요`,
        );
      }
    }
    if (stock.stopPrice != null && sig.stopPrice) {
      const diffPct = (Math.abs(stock.stopPrice - sig.stopPrice) / sig.stopPrice) * 100;
      if (diffPct > CONSISTENCY_DIVERGENCE_PCT) {
        warnings.push(
          `⚠️ AI 손절가(${stock.stopPrice.toLocaleString()}원)가 룰 엔진 1차 계산값(${sig.stopPrice.toLocaleString()}원)과 ${diffPct.toFixed(0)}% 차이 — 근거 재확인 필요`,
        );
      }
    }
    if (stock.actionScore != null) {
      const engineScore = sig.pnlPct != null ? sig.sellStrength : sig.buyStrength;
      if (engineScore != null && Math.abs(stock.actionScore - engineScore) > ACTION_SCORE_DIVERGENCE) {
        const label = sig.pnlPct != null ? "매도" : "매수";
        warnings.push(
          `⚠️ AI ${label} 강도(${stock.actionScore}점)가 룰 엔진 1차 계산값(${engineScore}점)과 크게 차이 — 근거 재확인 필요`,
        );
      }
    }
    if (warnings.length > 0) stock.checklist = [...stock.checklist, ...warnings];
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

// 자동수집 로그·직전 스냅샷 컨텍스트용 짧은 요약 텍스트 생성 (30분 간격 GitHub Actions에서 호출)
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
      model: SUMMARY_MODEL,
      max_tokens: 1400,
      system:
        "당신은 한국 주식 단타 트레이딩 전문가입니다. 반도체 5종목 투자자를 위한 짧은 시장 브리핑을 작성하세요. 형식: 이모지 포함 순수 텍스트(마크다운 금지). 종목마다 1줄로: 매수/매도 강도(0~10점) + 지금 필요한 구체적 행동(진입 트리거 또는 손절가). 강도 6점 이상인 종목만 우선 언급하고 나머지는 종목명만 나열해도 된다. VIX나 공포탐욕지수가 경계 수준이면 한 줄로 언급. 마지막에 주요 뉴스/리스크 한 줄.",
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
              매수강도_0to10: s.buyStrength,
              매도강도_0to10: s.sellStrength,
              VWAP대비: s.intraday?.available ? `${s.intraday.distanceFromVwapPct.toFixed(2)}%` : "데이터없음",
              갭: s.intraday?.available ? s.intraday.gapType : "데이터없음",
              진입트리거: s.entryTriggers.slice(0, 2),
              손절가: s.stopPrice,
              근거_상위: s.reasons.slice(0, 3),
              경고: s.warnings.slice(0, 2),
            })),
            매크로: {
              SOX: fmtQ(params.macro.sox),
              환율: fmtQ(params.macro.usdkrw),
              코스피: fmtQ(params.macro.kospi),
              VIX: params.macro.vix ? params.macro.vix.price.toFixed(1) : "정보없음",
              공포탐욕지수: params.macro.fearGreed ? `${params.macro.fearGreed.value}(${params.macro.fearGreed.ratingKo})` : "정보없음",
            },
            뉴스_상위: params.news.slice(0, 8).map((n) => `${n.isBreaking ? "[속보] " : ""}[${n.sentiment}/${n.impact}] ${n.title}`),
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
