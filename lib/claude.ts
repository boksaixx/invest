// Claude API로 최종 매매 조언을 생성한다.
// 엔진 신호(일봉+장중 기술적) + 뉴스(Gemini) + 매크로 + 포트폴리오를 종합해
// 전문 트레이더 관점의 최종 판단을 JSON으로 반환.
import Anthropic from "@anthropic-ai/sdk";
import type { AiAdvice, CollectedSnapshot, EngineSignal, MacroSnapshot, MarketPhaseInfo, NewsItem, Portfolio, StockTicker, TodayPlan } from "./types";
import { STOCKS } from "./types";
import { roundToTick } from "./tick";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
// 자동 수집(장중 최대 15분 간격)은 호출 빈도가 훨씬 높으므로 저렴한 모델을 기본값으로 사용해 월 비용을 통제한다.
const SUMMARY_MODEL = process.env.CLAUDE_SUMMARY_MODEL || "claude-haiku-4-5";

const SYSTEM = `당신은 20년 경력의 한국 주식 단기(데이트레이딩) 트레이딩 전문가입니다. 고객은 실전 자금으로 국내 10종목(삼성전자·SK하이닉스·한미반도체·삼성전기·DB하이텍(반도체) + 한화에어로스페이스(방산)·현대차(자동차)·KB금융(금융)·셀트리온(바이오)·KT(통신))만 원화로 단타 매매하며, 이번 거래에서 반드시 수익을 내야 하는 상황입니다. 고객은 투자 초보라 쉬운 한국어를 쓰되, 판단 자체는 프로 데이트레이더 수준으로 날카롭고 구체적이어야 합니다. "관망하세요" 한 마디로 끝내지 말고, 지금 무엇을 보고 있어야 하는지, 어떤 조건이 되면 행동해야 하는지까지 항상 제시하세요.

중요(업종 구분): 추적 종목은 반도체 5종목과 비반도체 5종목으로 나뉩니다. 아래 통계·보정은 국내 반도체 5종목으로 실측해 만든 것이라 **반도체 종목에만 적용**되며, 비반도체 종목에는 데이터에서 아예 빠지거나 "해당없음"으로 표시됩니다: 국면별_과거통계, 간밤 SOX 전이 보정, 폭락반등·급등익절 플레이북 실적. 비반도체 종목을 판단할 때 이 숫자들을 끌어다 쓰지 말고, 그 종목 자체의 변동성_추정·기술적 지표·수급·해당 업종 뉴스로만 판단하세요. 업종별 주된 동인은 데이터의 "업종"·"동인" 필드에 있습니다.

분산에 대한 사실(반드시 반영): 코스피 지수 자체가 반도체 5종목 블록과 상관 0.93입니다(삼성전자·SK하이닉스가 지수를 지배). 따라서 국내 종목을 여러 개 담아도 분산 효과는 제한적이며, 특히 반도체끼리는 상관 0.7~0.9로 사실상 한 종목입니다. "종목을 나눴으니 분산됐다"는 식으로 말하지 마세요.

요즘 시장은 변동성이 매우 큰 국면입니다 — 미국 반도체지수(SOX) 급등락, 국제 유가 급변동, 트럼프 등 주요 정치인의 발언(관세·수출규제) 한마디에 급등락, 국내 반도체 대장주(삼성전자·SK하이닉스)의 상한가, 반도체 레버리지 ETF가 하루 60% 가까이 움직이는 등 평소보다 훨씬 거친 장세가 이어지고 있습니다. 이런 환경에서는 어제까지 유효했던 목표가·손절가·진입 논리가 오늘 완전히 무효화될 수 있으므로, 아래 원칙을 특히 엄격히 적용하세요:
확률·국면 판단 규칙 (이 앱 조언의 뼈대):
- "국면별_과거통계"는 각 종목이 지금 어떤 국면인지와, 과거 같은 국면의 20거래일 후 실제 결과(중앙값·손실확률·추가급락확률·표본수)다. 반드시 국면 이름과 이 확률을 숫자로 인용해 설명하고, "표본부족" 표시가 있으면 그 한계를 함께 말한다. "과거에 이랬으니 이번에도 이렇다"는 단정은 금지 — 확률로만 말한다.
- 치명적 오판 방지: "지난 N개월 수익률이 좋았으니 계속 보유하면 된다"는 추론을 절대 하지 마라. 대세 상승장이 포함된 누적 수익률은 이미 무너진 국면에 적용되지 않는다. 고점 대비 -15% 이하로 하락한 상태에서는 과거 누적 수익률을 보유 근거로 인용하는 것 자체가 금지다.
- "보유대트레이딩"이 "보유우위"면 최근 수익이 대부분 밤사이 갭에서 났다는 뜻이라 매일 청산하는 단타는 그 수익원에 접근할 수 없다. 이때는 보유 물량을 팔아 단타 자금을 만들지 말라고 명확히 말하고, 단타는 여유 현금 소액으로만 권한다. 트레이딩을 권하는 것이 목적이 되어선 안 되며, 사용자의 실제 수익을 지키는 것이 목적이다.
- AI 업황 둔화, 전쟁·지정학, 환율 급등, 금리·국채 변동 같은 구조적 리스크가 뉴스에 있으면, 과거 통계가 그 리스크를 반영하지 못한다는 점을 반드시 밝힌다.

오늘의_작전(데이터 필드): 엔진이 장세를 스스로 판별(폭락장/급등과열/변동성확대/보통)해 그날 유효한 플레이북을 5개년 실데이터 검증 규칙으로 제시한 것이다. 조언은 반드시 이 작전과 일관되게: (1) 레짐과 판별 근거를 headline/insightReport에서 언급하고, (2) 작전의 트레이드(진입·익절·손절 또는 매도지정가)를 구체적 숫자로 인용하며, (3) 폭락장에서는 "갭하락 시가 패닉 매도는 실측상 무익(-0.13%p)"과 "폭락 반등 노림수는 소액(총자산 10% 이내)" 원칙을, 급등과열에서는 "추격 금지 + 다음날 +3% 지정가 분할 익절(실측 도달률 64%)"을, 눌림목에서는 "지정가 미체결이면 그날은 트레이드 없음(추격 금지)"을 강조한다. "매일 수익 보장"은 존재하지 않음을 전제로 말한다. "시장_신용잔고" 데이터가 있으면(빚투 급증 = 급락 시 반대매매 연쇄 위험) 리스크 판단에 반영해 언급한다.

- 종목마다 주어지는 "변동성_추정"을 항상 먼저 확인한다. 이는 5개년 실데이터로 검증한 모델이 계산한 값으로 레짐(평온/보통/높음/극단), 평소 대비 배율, 내일 90% 등락범위, 꼬리 방향(상방=급등 쪽이 더 두꺼움)을 담고 있다. 레짐이 "높음"이나 "극단"이면 포지션을 더 작게, 손절을 더 엄격히 가져가라고 명시적으로 조언하고, rationale에서 예상 등락범위를 구체적 숫자로 인용한다. 특히 손절가가 이 등락범위 안쪽에 있으면 "방향을 맞혀도 장중 흔들림에 손절당할 수 있다"는 점을 반드시 짚어준다.
- 고객이 장중에 화면을 보는 시간은 매우 불규칙하다(10분 볼 때도, 몇 시간~며칠 못 볼 때도 있다). 따라서 조언은 "9시 30분 캔들이 양봉이면" 같은 특정 시각 조건이 아니라, VWAP·피벗 지지/저항·전일 종가처럼 언제 봐도 그대로 판정되는 절대 가격 기준으로 쓴다. 매수를 권할 때는 손절가를 증권사 예약(감시)주문으로 걸어두라는 안내를 함께 넣되, "하루 이상 확인이 어려울 때"라는 조건을 반드시 붙인다 — 실측상 당일 안에 다시 볼 수 있으면 예약주문이 오히려 불리했다(스톱을 스치고 되돌아오는 날에 털리기 때문).
- 상한가/하한가(가격제한폭 도달) 신호가 있으면 절대 그날 추가로 쫓아 사지 말라고 강하게 경고하고, 익일 갭 리스크(다음날 시가가 크게 벌어질 위험)를 언급한다.
- 유가(WTI)나 SOX가 큰 폭으로 급변동한 날은 그 사실을 headline/rationale에서 구체적 수치로 인용하고, 그것이 오늘 판단에 어떻게 반영됐는지 설명한다.

데이터 읽는 법(중요): 추적 10종목 중 "보유 중이거나, 관망이 아닌 판단이 났거나, 점수가 한쪽으로 뚜렷하거나, 경고가 있는" 종목만 "룰엔진_신호"에 상세히 실립니다. 나머지는 "관망_종목_요약"에 한 줄로 압축됩니다 — 이 종목들은 보유도 신호도 없으니 관망으로 처리하고, 굳이 길게 분석하지 마세요(다만 stocks 배열에는 포함해 짧게라도 판단을 남기세요).
토큰 절약을 위해 "값이 없거나 지금 의미 없는 필드는 아예 생략"되어 전달됩니다. 필드가 보이지 않으면 그 데이터가 없거나(미확보) 현재 특별히 의미 있는 구간이 아니라는 뜻이니, 없는 값을 지어내지 말고 있는 값만 근거로 쓰세요. 예: 스토캐스틱은 과매수(80+)/과매도(20-)일 때만, 피벗 R1/S1은 현재가가 그 레벨 3% 이내일 때만, 다이버전스·해머캔들 같은 신호는 실제로 발생했을 때만 실립니다.

당신에게는 다음이 함께 주어집니다:
- 일봉 기술적 지표 (RSI, 20/60일 이동평균선=추세선, 거래량Z점수=거래량 기준 매수/매도세, 거래량_주=최근 완성된 거래일의 실제 거래량과 20일평균 대비 증감률=원시 수치. 실시간 장중 거래량 집계가 어려운 경우에도 이 값을 "가장 최근 확정된 거래량 근거"로 rationale에 구체적으로 인용할 것. 스토캐스틱=RSI를 보완하는 단기 모멘텀(과매수/과매도 구간일 때만 제공), 피벗 R1/S1=직전 거래일 기준 단기 저항/지지선(현재가가 근접했을 때만 제공되며, 제공되면 목표가·손절가·entryTriggers를 이 레벨과 연계해 더 구체적으로 제시할 것))
- 변동성_추정: 5개년 실데이터로 검증한 모델이 산출한 "내일 이 종목이 얼마나 움직일 수 있는가". 검증상 90% 등락범위의 실제 적중률은 약 88%이므로 확정 예측이 아니라 "이 정도는 각오해야 하는 범위"로 해석하고, 경계값은 보수적으로 다룬다.
- ADX_추세강도(방향과 무관하게 "추세가 얼마나 강한지"): "추세장"(25+)이면 추세추종(이평선/MACD 방향)을 우선 신뢰하고 저점매수는 신중히(추세가 강할 땐 떨어지는 칼날일 위험), "횡보장"(20 미만)이면 반대로 저점매수/되돌림 신호(RSI 과매도, 다이버전스, 해머캔들, 볼린저 하단, 피벗 S1)를 더 신뢰한다. 룰 엔진의 점수 자체가 이미 이 로직으로 가중치를 조정해 계산돼 있으니, rationale에서 "지금이 추세장인지 횡보장인지"를 근거로 명시적으로 언급할 것 — "오를 때만 올라타는" 단순 모멘텀 추종이 아니라 장세에 맞는 전략을 쓰고 있음을 보여줘야 한다.
- RSI강세다이버전스(true면 가격은 이전 저점보다 낮은데 RSI는 더 높음 = 하락 모멘텀 약화, 저점매수 확인 신호), RSI약세다이버전스(반대로 상승 모멘텀 약화, 보유자 경고), 해머형반전캔들(하락 흐름 중 저가권 매도세 흡수 캔들), OBV다이버전스(가격 추세와 거래량 추세가 엇갈림 = 뒷받침 약한 움직임 경고) — 이런 신호가 true면 반드시 rationale에서 구체적으로 언급하고, 특히 RSI강세다이버전스나 해머형반전캔들은 "지금 막 오르고 있어서"가 아니라 "하락이 멈추는 신호가 나와서" 매수를 고려한다는 저점매수 논리로 headline/rationale을 구성할 수 있다.
- 장중(분봉) 데이터: VWAP(거래량가중평균가), 갭(전일 종가 대비 시가), 오프닝레인지(개장 첫 30분 고저) 브레이크아웃 상태, 최근 30분 모멘텀
- 룰 엔진이 1차 계산한 진입 트리거(entryTriggers)·무효화 조건(invalidation)·분할 매수/매도 라인(scaledEntry/scaledExit)·예상 왕복 거래비용·매수강도(buyStrength)·매도강도(sellStrength)·엔진 자체 판정문(verdict)
- 상대강도 순위: 반도체 그룹과 비반도체 그룹으로 나눠 랭킹이 주어진다. 비반도체는 업종이 제각각이라 순위 자체보다 "오늘 어느 업종이 버티는가"를 읽는 용도로 쓴다.
- 매크로: 환율(원/달러), 코스피, 나스닥, 미 반도체지수(SOX, 폭등/폭락 시 다음날 국내 반도체주 갭으로 이어지는 경우가 많아 특히 중요), S&P500·나스닥100 선물(오버나이트 방향성), VIX(변동성지수), CNN 공포탐욕지수, 국제유가(WTI, 급변동 시 방향과 무관하게 매크로 리스크 확대 신호). "미10년물국채금리_점수미반영"은 크게 움직인 날에만 들어오며, 이름 그대로 룰 엔진 점수에 반영되지 않은 값이다(기여도를 아직 실측하지 못해 검증 전까지 점수에서 제외) — 금리 급등은 기술주 밸류에이션에 불리하다는 맥락으로만 인용하고, 점수와 충돌하는 결론의 유일한 근거로 삼지 마라. 이 요소들을 종합해 룰 엔진이 별도로 산출한 매크로_영향도점수(양수=우호적/음수=비우호적, 개별 종목 점수에 이미 가산/감산되어 있음)도 함께 제공된다 — 헤드라인/rationale에서 매크로 여건을 언급할 때 이 점수를 구체적 근거로 인용할 수 있다.
- 포트폴리오 업종 집중도 경고 (반도체 합산 60%+ 또는 특정 비반도체 업종 50%+일 때 표시됨) 및 상관 종목 합산 비중 한도 경고
- 지금이 장의 어느 시간대인지 — 국내장(장전/장초반/장중/점심시간대/마감임박 등)과 미국장은 개장시간이 다르므로(미국은 한국시간 기준 저녁~새벽) 각 종목은 자신이 속한 시장의 장상태 기준으로 판단한다. 시세 데이터 수집 시각도 함께 제공됨.
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
8. 국내 종목은 장초반(09:00~09:30)·점심시간대(11:30~13:00), 미국 종목은 장초반(현지 09:30~10:00)·점심시간대(현지 12:00~13:00)에 신호 신뢰도가 낮으니 이를 언급하고 신중함을 권한다. 각 종목의 장상태 데이터를 반드시 그 종목이 속한 시장 기준으로 읽는다(국내 종목에 미국장 시간을 적용하거나 그 반대로 섞어 쓰지 말 것). 장전 시간대는 미국 선물(ES/NQ) 방향을 우선 근거로 삼는다.
9. VIX가 25 이상이거나 공포탐욕지수가 극단값(25 이하 또는 75 이상)이면 시장 전체 변동성이 커진 상황임을 명시하고 포지션 크기를 보수적으로 가져가라고 조언한다.
10. 반도체 5종목을 동시에 많이 보유하면 상관 0.7~0.9라 사실상 한 종목에 몰아넣은 것임을 인지시킨다(섹터 집중도·상관 한도 경고가 오면 반드시 언급). 비반도체 종목은 서로 다른 동인을 가지므로 분산 목적이라면 업종을 섞으라고 조언한다.
11. invalidation(무효화 조건)은 목표가·손절가와 별개로 "이 매매 논리 자체가 틀렸다"고 판단할 구체적 트리거(가격 레벨 또는 매크로 반전)로 채운다. 애매하게 쓰지 말 것.
12. headline과 rationale 중 최소 1곳 이상에는 반드시 구체적 숫자(가격·비율·지표값)를 인용해야 한다. "분위기가 좋다", "관심 필요" 같은 추상적 표현만으로 채우는 것은 금지.
13. 확정적 수익을 약속하지 않으며, 모든 판단은 확률적 우위에 근거함을 전제로 한다. 시세는 무료 공개 API 기준이라 최대 15~20분 지연될 수 있음을 인지하고, 실제 주문 직전 증권사 앱에서 최신가를 반드시 재확인하라고 checklist에 포함한다.
14. 최신 뉴스/속보 중 발행시각이 가장 최근이고 impact가 "높음"인 항목을 최우선으로 반영한다. 오래됐거나(예: 1일 이상 경과) 영향도가 낮은 뉴스보다 방금 나온 고영향 뉴스가 판단을 바꿀 수 있다면 headline과 rationale에서 그 사실을 명시적으로 언급한다.
15. 토큰 절약을 위해 rationale은 최대 3개, checklist는 최대 2개, entryTriggers는 최대 2개 항목으로 간결하게 작성한다. 길게 쓰지 말고 핵심만 담는다.
16. timeHorizon(투자 시계열)을 항상 명시한다 — entryTriggers가 오늘 장중에 충족될 가능성이 높으면 "당일", 며칠에 걸쳐 조건(예: 눌림목, 되돌림, 추가 뉴스 확인)이 갖춰질 성격이면 "수일내(스윙)"로 표시한다. 이 앱은 단타 전용이므로 "수일내"라도 최대 며칠 내 단기 스윙을 의미하며 중장기 투자를 뜻하지 않는다.
17. 최근 DART 공시가 있는 종목은 뉴스보다 우선해 headline/rationale에 구체적으로 반영한다(공시 제목과 접수일 인용). 공시와 뉴스가 같은 사안을 다루면 공시 쪽 시각을 기준으로 최신성을 판단한다.
18. rationale/checklist/entryTriggers/invalidation에서도 RSI·MACD·ADX·볼린저·스토캐스틱·다이버전스·OBV·피벗·VWAP 같은 지표명을 그냥 나열하지 말고, "지금 과매수 구간이라 위험해요(RSI 74)"처럼 그 지표가 뜻하는 상황을 먼저 쉬운 말로 설명한 뒤 괄호로 수치/용어를 덧붙인다. 고객은 이런 용어를 전혀 모른다고 가정하고 쓴다.

actionScore(0~10점, 정수) — 초보자가 화면에서 가장 먼저 보는 단일 숫자이니 신중하게 산정한다:
- 미보유 종목: "지금 얼마나 강하게 신규 매수해야 하는가"를 0~10점으로. 룰 엔진이 계산한 buyStrength를 1차 기준으로 삼되, 뉴스·매크로·상대강도로 조정 가능. 8~10=지금 강하게 매수, 5~7=매수 고려(트리거 확인), 0~4=아직 근거 부족(관망).
- 보유 종목이면서 action이 "추가매수"(수익 중 피라미딩)인 경우: 매도가 아니라 "지금 얼마나 강하게 추가로 사야 하는가"를 0~10점으로. 룰 엔진의 buyStrength를 1차 기준으로 삼되 조정 가능.
- 보유 종목이면서 action이 그 외(보유/부분매도/전량매도/손절)인 경우: "지금 얼마나 강하게 매도해야 하는가"를 0~10점으로. 룰 엔진의 sellStrength를 1차 기준으로 삼되 조정 가능. 8~10=즉시 매도(손절 포함), 4~7=일부 매도 고려, 0~3=계속 보유.
- 엔진값과 다르게 판단했다면(예: 뉴스 악재로 엔진보다 매도 강도를 높임) 그 이유를 rationale에 반드시 명시한다.

entryPrice(매수 진입가)는 "지금 얼마에 사야 하는가"가 유효한 경우에만 구체적 숫자로 제시한다: 미보유 종목(action이 신규매수/관망), 그리고 보유 종목이라도 action이 "추가매수"(피라미딩)인 경우. action이 신규매수/추가매수면 "지금 이 가격에 사라"는 뜻이므로 보통 현재가(엔진_매수진입가_초안) 그대로, action이 관망이면 "이 가격까지 오면/이 조건이 되면 사라"는 뜻이므로 엔진_매수진입가_근거(VWAP·20일선 등)를 참고해 조정 가능하되 rationale에 왜 그 가격인지(어떤 지표·레벨 근거인지) 반드시 명시한다. 보유 중이면서 action이 그 외(보유/부분매도/전량매도/손절, 즉 매도 판단이거나 단순 보유)이면 매수 진입 개념이 없으므로 entryPrice는 null.

보유 중인 종목에 대해서는 매수 판단(추가매수 여부)뿐 아니라 반드시 "언제, 얼마나 팔아야 하는지"도 rationale이나 checklist에서 구체적으로 짚어준다 — 목표가/손절가 숫자만 나열하지 말고, 룰 엔진의 분할매도라인(scaledExit, 1차 익절/2차 익절 가격·수량)을 참고해 "OO원에서 절반, XX원에서 나머지"처럼 실행 가능한 형태로 설명할 것.

headline은 전문가가 초보자에게 말하듯 쉬운 한 문장으로 명확한 입장을 담는다 — 예: "지금 사도 좋아요", "조금 더 지켜보세요(관망)", "지금은 절대 사지 마세요(과열 구간)", "지금 파세요(손절 원칙)". 애매한 말은 피하고, 근거(환율/거래량/추세선/뉴스)는 rationale에서 숫자로 뒷받침한다.

룰 엔진이 계산한 신호와 트리거는 1차 초안일 뿐입니다. 뉴스·매크로·장중 데이터와 교차 검증해 최종 판단하고, 엔진과 다른 결론이면 그 이유를 rationale에 명확히 설명하세요. entryTriggers와 invalidation은 룰 엔진 값을 그대로 복사하지 말고, 지금 데이터에 맞게 더 구체적으로 다듬어 작성하세요.
action은 다음 중 하나만: 신규매수, 추가매수, 보유, 부분매도, 전량매도, 손절, 관망.

insightReport(종합 인사이트 리포트) — 분석 버튼을 누를 때마다 새로 생성되는 리포트로, 개별 종목 판단과 별개로 "지금 이 순간" 전체 그림을 알려준다. 이 리포트는 이 앱에서 사용자가 가장 먼저, 가장 비중있게 읽는 글이므로 문체 규칙을 반드시 지킨다:
  · 중학생도 이해할 수 있는 쉬운 일상 말로 쓴다. "~해요/~예요" 체를 쓰고, 마치 친한 전문가가 옆에서 설명해주듯 자연스럽게 쓴다.
  · RSI, MACD, ADX, 볼린저(밴드), 스토캐스틱, 다이버전스, OBV, 피벗, VWAP 같은 전문용어를 문장에 그대로 노출하지 않는다. 반드시 "주가가 최근 계속 한 방향으로 세게 움직이고 있어요", "떨어지는 속도가 느려지고 있어서 곧 반등할 수 있다는 신호가 나왔어요", "최근 며칠 사이 사려는 사람이 파는 사람보다 많았어요"처럼 그 지표가 의미하는 "현상"을 쉬운 말로 먼저 설명한다. 전문용어를 굳이 밝히고 싶으면 문장 끝에 괄호로 참고만 덧붙인다(예: "(전문용어로는 다이버전스라고 해요)").
  · 각 항목은 2~4문장이며 반드시 구체적 숫자(가격·%·점수 등)를 최소 1개 포함하되, 숫자를 말할 때도 "RSI가 72"가 아니라 "지금 인기가 너무 몰려서 과열 신호(72점, 70점 넘으면 과열)가 떴어요"처럼 그 숫자가 좋은건지 나쁜건지 바로 알 수 있게 설명을 붙인다.
  · "분위기가 좋다", "관심 필요" 같은 알맹이 없는 말만으로 채우지 않는다.
- marketRegime: 오늘 주식시장이 전반적으로 어떤 상태인지(계속 오르거나 내리는 흐름인지, 오르락내리락 횡보하는지) + 환율·VIX(변동성)·공포탐욕지수·미국 선물 같은 큰 배경이 지금 반도체株에 유리한지 불리한지를 쉬운 말로.
- technicalSynthesis: 6종목의 차트 신호들을 종합해서 지금이 "너무 많이 올라서 위험한 구간"인지 "떨어지다가 멈출 조짐"인지 "특별한 신호 없이 애매한 구간"인지 쉬운 말로. 유독 다른 흐름을 보이는 종목이 있으면 그것도 짚어준다.
- flowAndSentiment: 외국인·기관투자자(큰손)가 최근 사고 있는지 팔고 있는지, 최신 뉴스·공시 분위기가 좋은지 나쁜지, 이 둘이 같은 방향인지 엇갈리는지를 쉬운 말로.
- keyRisks: 지금 반드시 조심해야 할 것 1~2가지를 쉬운 말로 구체적으로(예: "지금 따라 사면 고점에 물릴 위험이 커요", "반도체 관련주에 다 넣으면 계란을 한 바구니에 담는 셈이라 위험해요").
- actionPlan: 6종목 중 지금 가장 먼저 볼 종목과 순서, 그 이유를 한 문단으로 쉽게 — 화면 상단 종목별 카드를 보기 전에 먼저 읽고 "오늘은 이런 느낌이구나"를 파악할 수 있도록.`;

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
            description: "매수 진입가. action이 신규매수/추가매수(보유 중 피라미딩 포함)면 지금 당장 살 가격(보통 현재가), 관망이면 트리거 충족 시 살 목표 가격. 보유 중이면서 action이 그 외(보유/부분매도/전량매도/손절)이면 null. 근거는 rationale에 구체적으로 남길 것.",
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
  relativeStrengthSummary?: string | null; // 국내/미국 그룹별 상대강도 랭킹 요약 (합쳐진 문자열)
  sectorConcentrationWarning?: string | null; // 섹터/테마 집중도 경고 (있으면)
  todayPlan?: TodayPlan | null; // 오늘의 작전 — 엔진이 판별한 레짐과 플레이북 (조언의 중심 축)
  creditNote?: string | null; // 시장 신용잔고(빚투) 요약 — KOFIA 연동 실패 시 null
}): Promise<{ advice: AiAdvice | null; error: string | null }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { advice: null, error: "ANTHROPIC_API_KEY 미설정 (Vercel 환경변수 확인 필요)" };
  // 타임아웃(ms) — 웹 요청 안에서 도는 호출이므로 재시도는 1회로 제한
  const client = new Anthropic({ apiKey, timeout: 150_000, maxRetries: 1 });

  const { signals, macro, news, portfolio } = params;

  const krPhase = signals.find((s) => STOCKS[s.ticker].market === "KR")?.marketPhase ?? null;
  const usPhase = signals.find((s) => STOCKS[s.ticker].market === "US")?.marketPhase ?? null;

  // 페이로드에서 한 줄로 압축된 종목 — 이 종목들의 AI 가격은 근거가 없으므로 나중에 버린다
  const quietTickers = new Set(signals.filter((s) => !needsDetail(s, params.portfolio)).map((s) => s.ticker as string));
  const userContent = JSON.stringify(buildAdvicePayload({ ...params, krPhase, usPhase }));

  // 프롬프트 캐싱 — SYSTEM(약 4천 토큰)과 과거 이벤트 목록은 호출마다 완전히 동일하다.
  // 캐시에 적중하면 이 부분 입력 비용이 1/10로 떨어지므로, 사용자가 분석 버튼을 여러 번
  // 누르는 실제 사용 패턴에서 비용이 크게 줄어든다(캐시 유지 1시간).
  const eventsText = `참고용 과거 주요 이벤트 타임라인(고정 데이터):\n${(params.events ?? []).map((e) => `${e.date} ${e.title}: ${e.note}`).join("\n")}`;
  const userMessage = `아래 데이터를 종합해 지금 시점의 최종 매매 조언을 JSON으로 작성하세요. 단타이므로 "지금 뭘 봐야 하는지"를 반드시 구체적 가격과 조건으로 제시하세요.\n\n${userContent}`;
  const baseRequest = {
    model: MODEL,
    max_tokens: 6800, // 5종목 분량 + insightReport 5개 섹션 출력이 필요해 상향 (실제 과금은 규칙15의 항목 수 제한으로 억제)
    output_config: {
      effort: "medium" as const, // 사용자가 화면에서 기다리는 호출이므로 응답 속도 우선
      format: { type: "json_schema" as const, schema: ADVICE_SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user" as const, content: userMessage }],
  };

  try {
    let response;
    try {
      response = await client.messages.create({
        ...baseRequest,
        system: [
          { type: "text" as const, text: SYSTEM },
          { type: "text" as const, text: eventsText, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } },
        ],
      });
    } catch (cacheErr) {
      // 캐싱은 비용 최적화일 뿐이라 실패해도 조언 자체는 나와야 한다.
      // (예: 계정/모델이 1시간 캐시 TTL을 아직 지원하지 않는 경우) 캐시 없이 한 번 더 시도한다.
      console.warn("프롬프트 캐싱 요청 실패 — 캐시 없이 재시도합니다:", cacheErr);
      response = await client.messages.create({
        ...baseRequest,
        system: `${SYSTEM}\n\n${eventsText}`,
      });
    }
    if (response.stop_reason === "refusal") {
      return { advice: null, error: "AI가 이 요청의 응답을 거절했습니다. 잠시 후 다시 시도해주세요." };
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return { advice: null, error: "AI 응답 형식 오류" };
    const parsed = sanitizeAdvicePrices(JSON.parse(text.text) as Omit<AiAdvice, "generatedAt">, signals, quietTickers);
    applyConsistencyCheck(parsed, signals);
    return { advice: { ...parsed, generatedAt: new Date().toISOString() }, error: null };
  } catch (e) {
    console.error("Claude 조언 생성 실패:", e);
    return { advice: null, error: describeAnthropicError(e) };
  }
}

// 값이 없는 필드는 아예 빼서 토큰을 아낀다. "정보없음"/false/null을 6종목분 반복 전송하면
// 정보량 0인 텍스트에 매 호출 수백 토큰을 쓰게 된다 — 없는 필드는 없는 것으로 읽히면 충분하다.
// (SYSTEM 프롬프트에 "필드가 없으면 데이터 미확보"라는 규칙을 명시해두었다.)
function prune<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === false || v === "" ) continue;
    if (typeof v === "number" && isNaN(v)) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Claude에 보낼 데이터 페이로드를 만든다.
 *
 * 토큰 최소화 원칙 (scripts/measure-tokens.ts 로 실측하며 조정):
 *  1. 종목마다 동일한 값(매크로 점수, 거래량 기준일 등)은 최상위로 한 번만 보낸다.
 *  2. 값이 없거나 의미 없는 필드(false, null, "정보없음")는 생략한다.
 *  3. 지표는 "지금 의미 있을 때만" 보낸다 — 예: 스토캐스틱은 과매수/과매도 구간일 때만,
 *     피벗선은 현재가가 그 레벨 근처(3% 이내)일 때만.
 *  4. 배열·객체 대신 사람이 읽는 한 줄 문자열로 압축한다(JSON 구조 문자 자체가 토큰이다).
 */
/**
 * 상세히 보낼 종목인지 판정. 추적 종목이 10개로 늘면서 전 종목을 같은 깊이로 실으면
 * 입력이 50% 불어나는데, "보유도 아니고 신호도 없고 점수도 중립"인 종목은 길게 읽어도
 * 결론이 관망으로 같다. 판단이 필요한 종목만 상세히 싣는다.
 *
 * generateAdvice의 응답 정제도 같은 기준을 써야 하므로(상세를 안 준 종목의 AI 가격은 버린다)
 * 여기 한 곳에서만 정의한다.
 */
export function needsDetail(s: EngineSignal, portfolio: Portfolio): boolean {
  const held = portfolio.holdings.some((h) => h.ticker === s.ticker && h.qty > 0);
  return held || s.action !== "관망" || s.score >= 62 || s.score <= 38 || s.warnings.length > 0;
}

export function buildAdvicePayload(params: {
  signals: EngineSignal[];
  macro: MacroSnapshot;
  news: NewsItem[];
  portfolio: Portfolio;
  history?: CollectedSnapshot | null;
  events?: { date: string; title: string; note: string }[];
  relativeStrengthSummary?: string | null;
  sectorConcentrationWarning?: string | null;
  krPhase?: MarketPhaseInfo | null;
  usPhase?: MarketPhaseInfo | null;
  todayPlan?: TodayPlan | null;
  creditNote?: string | null;
}): Record<string, unknown> {
  const { signals, macro, news, portfolio } = params;
  const volumeBasis = signals.some((s) => s.intraday?.available && s.intraday.isToday)
    ? "오늘(장중 진행 중)"
    : "가장 최근 거래일(마감)";

  const focusSignals = signals.filter((s) => needsDetail(s, params.portfolio));
  const quietSignals = signals.filter((s) => !needsDetail(s, params.portfolio));

  // 종목마다 같은 문장이 반복되는 필드는 최상위로 올려 한 번만 싣는다
  const invalidations = focusSignals.map((s) => trimInvalidation(s.invalidation));
  const invalidationIsShared = invalidations.length > 1 && invalidations.every((v) => v !== null && v === invalidations[0]);

  return prune({
    무효화조건_공통: invalidationIsShared ? invalidations[0] : null,
    현재시각_KST: new Date(Date.now() + 9 * 3600_000).toISOString().replace("Z", "+09:00"),
    장상태_국내: params.krPhase ?? null,
    장상태_미국: params.usPhase ?? null,
    // 오늘의 작전 — 조언의 중심 축이므로 항상 전송하되 한 줄씩 압축(토큰 절약)
    오늘의_작전: params.todayPlan
      ? prune({
          레짐: `${params.todayPlan.regime} (${params.todayPlan.regimeNote})`,
          트레이드: params.todayPlan.trades.length
            ? params.todayPlan.trades.map((t) => {
                const u = t.currency === "USD" ? "$" : "원";
                if (t.kind === "급등익절") return `${t.name} 급등익절: 내일 ${t.sellLimitPrice?.toLocaleString()}${u} 지정가로 ${t.suggestedQty ?? "?"}주 매도`;
                if (t.kind === "폭락반등매수") return `${t.name} 폭락반등: 마감 동시호가 소액매수(${t.suggestedQty ?? "?"}주, 총자산 10%이내) → 익일 종가 청산`;
                return `${t.name} 눌림목: ${t.entryPrice?.toLocaleString()}${u} 지정가 → 익절 ${t.targetPrice?.toLocaleString()} / 손절 ${t.stopPrice?.toLocaleString()}`;
              })
            : null,
          // 보유자 지침의 상세 근거(패닉 매도 무익 -0.13%p 등)는 SYSTEM 프롬프트에 이미 있고
          // 그쪽은 캐시되어 1/10 비용이다. 여기선 첫 문장만 짧게 보내 중복 과금을 피한다.
          // 보유 vs 트레이딩 우열 — 단타를 권할 상황인지 판단하는 핵심 근거
          // 국면별 조건부 전망 — 읽는 법은 SYSTEM(캐시됨)에 있으므로 여기선 수치만 압축 전달.
          // 같은 국면인 종목은 이름을 묶어 한 줄로 합친다.
          국면별_과거통계: params.todayPlan.scenarios.length
            ? (() => {
                const byLabel = new Map<string, string[]>();
                for (const sc of params.todayPlan!.scenarios) {
                  byLabel.set(sc.label, [...(byLabel.get(sc.label) ?? []), sc.name]);
                }
                return [...byLabel.entries()].slice(0, 3).map(([label, names]) => {
                  const sc = params.todayPlan!.scenarios.find((x) => x.label === label)!;
                  // note 문장에서 핵심 수치만 뽑아 압축 (중앙값/손실확률/표본)
                  const med = sc.note.match(/중앙값 ([+-]?[\d.]+)%/)?.[1] ?? "?";
                  const loss = sc.note.match(/손실로 끝난 비율이 (\d+)%/)?.[1] ?? "?";
                  const crash = sc.note.match(/(\d+)%는 20% 넘게/)?.[1];
                  const n = sc.note.match(/국면 (\d+)회/)?.[1] ?? "?";
                  return `${names.join("·")}: ${label} / 20일후 중앙 ${med}% 손실확률 ${loss}%${crash ? ` 추가급락 ${crash}%` : ""} (n=${n}${sc.lowConfidence ? ", 표본부족" : ""})`;
                });
              })()
            : null,
          보유대트레이딩: params.todayPlan.holdEdge?.available
            ? `${params.todayPlan.holdEdge.verdict} (최근 6개월 갭 ${params.todayPlan.holdEdge.overnightPct.toFixed(0)}%p / 장중 ${params.todayPlan.holdEdge.intradayPct.toFixed(0)}%p)`
            : null,
          보유자지침: params.todayPlan.holderGuide.length
            ? params.todayPlan.holderGuide.map((g) => g.split(" — ")[0]).slice(0, 2)
            : null,
        })
      : null,
    시장_신용잔고: params.creditNote ?? null,
    거래량_기준일: volumeBasis,
    // 매크로 영향도 점수는 같은 시점 모든 종목이 동일하므로 최상위에 한 번만 싣는다.
    매크로_영향도점수: signals[0]?.macroScore ?? null,
    상대강도_랭킹: params.relativeStrengthSummary ?? null,
    섹터집중도_경고: params.sectorConcentrationWarning ?? null,
    포트폴리오: portfolio,
    // 추적 종목이 10개로 늘면서, 전 종목을 같은 깊이로 실으면 입력이 50% 불어난다.
    // 그런데 "보유도 아니고 신호도 없고 점수도 중립"인 종목은 Claude가 길게 읽어봐야 결론이
    // 똑같이 관망이다. 그래서 판단이 필요한 종목만 상세히 싣고 나머지는 한 줄로 압축한다.
    // (압축된 종목도 이름·가격·점수·변동성은 남아 있어 Claude가 "왜 뺐는지" 알 수 있다)
    관망_종목_요약: quietSignals.length
      ? quietSignals.map(
          (s) =>
            `${s.name}(${STOCKS[s.ticker].sector}) ${Math.round(s.price).toLocaleString()} ${s.score >= 50 ? "+" : ""}${s.score - 50}p ` +
            `일간±${s.volForecast ? s.volForecast.sigmaDailyPct.toFixed(1) : "?"}% — 보유없음·신호없음`,
        )
      : null,
    룰엔진_신호: focusSignals.map((s) => {
      const ind = s.indicators;
      const near = (level: number) => !isNaN(level) && s.price > 0 && Math.abs(level - s.price) / s.price <= 0.03;
      const vf = s.volForecast;
      return prune({
        종목: s.name,
        ticker: s.ticker,
        통화: STOCKS[s.ticker].currency === "USD" ? "달러" : "원",
        현재가: s.price,
        엔진판단: s.action,
        점수: s.score,
        보유중여부: s.pnlPct != null,
        엔진_매수강도_0to10: s.buyStrength,
        엔진_매도강도_0to10: s.sellStrength,
        엔진_판정문: s.verdict,
        최근공시: s.disclosures.length > 0
          ? s.disclosures.slice(0, 3).map((d) => `[${d.sentiment}] ${d.title} (${d.date})`)
          : null,
        전일까지_외국인기관수급_주: s.investorFlow.length > 0
          ? s.investorFlow.slice(-3).map((f) => `${f.date}: 외국인 ${f.foreignNet >= 0 ? "+" : ""}${f.foreignNet.toLocaleString()} / 기관 ${f.institutionNet >= 0 ? "+" : ""}${f.institutionNet.toLocaleString()}`)
          : null,
        // 엔진_판정문은 근거 1순위 문장을 그대로 품고 있는 경우가 많다 — 같은 문장을 두 번
        // 보내지 않도록 판정문에 이미 담긴 근거는 제외한다(6종목이면 매 호출 수백 자 절약).
        근거: s.reasons.filter((r) => !s.verdict.includes(r)).slice(0, 3),
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
        // 무효화 조건은 종목마다 가격 레벨이 달라 최상위로 못 옮기지만, 뒷부분 정형 문구
        // ("...목표가·손절가 도달 여부와 무관하게 즉시 재검토")는 6종목 내내 똑같이 반복된다.
        // 그 규칙은 SYSTEM(캐시되어 1/10 비용)에 이미 있으므로 트리거 부분만 보낸다.
        // 전 종목 동일하면 아래 최상위 "무효화조건_공통"으로 한 번만 보낸다(중복 제거)
        무효화조건_엔진초안: invalidationIsShared ? null : trimInvalidation(s.invalidation),
        // 분할 라인은 객체 배열 대신 "가격x수량" 한 줄로 압축
        분할매수라인: s.scaledEntry.length ? s.scaledEntry.map((o) => `${o.price}x${o.qty ?? "?"}`).join(", ") : null,
        분할매도라인: s.scaledExit.length ? s.scaledExit.map((o) => `${o.price}x${o.qty ?? "?"}`).join(", ") : null,
        과거백테스트_참고용: s.backtest
          ? `표본 ${s.backtest.sampleSignals}회, 5일후 승률 ${s.backtest.winRate5d ?? "?"}% 평균 ${s.backtest.avgReturn5d ?? "?"}%`
          : null,
        // 내일 예상 등락폭 — 5개년 실데이터로 검증한 변동성 모델(lib/volatility.ts) 결과.
        // 종목 카드에서 가장 실전적인 숫자라 한 줄로 압축해 항상 싣는다.
        변동성_추정: vf
          ? `레짐 ${vf.regime}(평소의 ${vf.regimeRatio.toFixed(1)}배, 일간 ±${vf.sigmaDailyPct.toFixed(1)}%), 내일 90% 등락범위 ${vf.range90.lowPct.toFixed(1)}%~+${vf.range90.highPct.toFixed(1)}%, 꼬리 ${vf.skew}`
          : null,
        일봉지표: prune({
          RSI14: round1(ind.rsi14),
          MA20: Math.round(ind.ma20),
          MA60: Math.round(ind.ma60),
          거래량Z점수: round2(ind.volumeZ),
          거래량_주: Math.round(ind.lastVolume).toLocaleString(),
          "20일평균대비": isNaN(ind.avgVolume20) || ind.avgVolume20 <= 0
            ? null
            : `${ind.lastVolume >= ind.avgVolume20 ? "+" : ""}${((ind.lastVolume / ind.avgVolume20 - 1) * 100).toFixed(0)}%`,
          // 스토캐스틱은 과매수(80+)/과매도(20-) 구간일 때만 의미가 있다
          스토캐스틱: !isNaN(ind.stochK) && (ind.stochK >= 80 || ind.stochK <= 20)
            ? `%K ${round1(ind.stochK)} (${ind.stochK >= 80 ? "과매수" : "과매도"})`
            : null,
          // 피벗선은 현재가가 근처일 때만 의미가 있다
          피벗_R1: near(ind.pivotR1) ? Math.round(ind.pivotR1) : null,
          피벗_S1: near(ind.pivotS1) ? Math.round(ind.pivotS1) : null,
          "ADX_추세강도": isNaN(ind.adx14)
            ? null
            : `${round1(ind.adx14)} (${ind.adx14 >= 25 ? "추세장" : ind.adx14 < 20 ? "횡보장" : "전환구간"})`,
          // 아래 신호들은 true일 때만 의미가 있다 (false는 prune이 제거)
          RSI강세다이버전스: ind.bullishDivergence,
          RSI약세다이버전스: ind.bearishDivergence,
          해머형반전캔들: ind.hammerReversal,
          OBV다이버전스: ind.obvDivergence,
        }),
        장중지표: s.intraday?.available
          ? `VWAP ${Math.round(s.intraday.vwap)}(${s.intraday.distanceFromVwapPct >= 0 ? "+" : ""}${s.intraday.distanceFromVwapPct.toFixed(2)}%), 갭 ${s.intraday.gapType} ${s.intraday.gapPct >= 0 ? "+" : ""}${s.intraday.gapPct.toFixed(2)}%, ${s.intraday.orbStatus}, 모멘텀 ${s.intraday.momentum}`
          : "장중 데이터 없음(일봉 기준 판단)",
      });
    }),
    매크로: prune({
      환율: fmtQ(macro.usdkrw),
      코스피: fmtQ(macro.kospi),
      나스닥: fmtQ(macro.nasdaq),
      필라델피아반도체: fmtQ(macro.sox),
      니케이: fmtQ(macro.nikkei),
      상해: fmtQ(macro.shanghai),
      SP500선물: fmtQ(macro.spFutures),
      나스닥100선물: fmtQ(macro.nasdaqFutures),
      VIX: macro.vix ? `${macro.vix.price.toFixed(1)} (${macro.vix.changePct >= 0 ? "+" : ""}${macro.vix.changePct.toFixed(1)}%)` : null,
      공포탐욕지수: macro.fearGreed ? `${macro.fearGreed.value} (${macro.fearGreed.ratingKo})` : null,
      국제유가_WTI: fmtQ(macro.oil),
      // 미 10년물 국채금리 — 기술주 할인율 리스크의 대표 지표. 다만 자체 히스토리가 없어
      // 기여도를 실측하지 못했으므로 점수에는 반영하지 않고, 평소와 다를 때만 맥락으로 보낸다
      // (매일 보내면 토큰만 쓰고 판단은 안 바뀐다).
      미10년물국채금리_점수미반영:
        macro.us10y && Math.abs(macro.us10y.changePct) >= 2
          ? `${macro.us10y.price.toFixed(2)}% (${macro.us10y.changePct >= 0 ? "+" : ""}${macro.us10y.changePct.toFixed(1)}%)`
          : null,
    }),
    // 뉴스는 객체 배열 대신 한 줄 문자열로 — 필드명 반복(title/summary/sentiment...)만으로도
    // 10건이면 수백 토큰이 낭비된다. 판단에 필요한 정보는 그대로 유지된다.
    최신뉴스: news.slice(0, 10).map((n) =>
      `${n.isBreaking ? "[속보]" : ""}[${n.sentiment}/${n.impact}] ${n.title} — ${n.summary} (${n.relatedTo}, ${n.source}, ${n.publishedAt})`,
    ),
    직전_자동수집_요약: params.history?.aiSummary ?? null,
  });
}

/** 무효화 조건에서 "목표가/손절가와 무관하게…" 같은 상투구를 떼어 토큰을 아낀다 */
function trimInvalidation(v: string | null): string | null {
  return v ? v.split(/\s*(?:발생\s*시|시),\s*목표가/)[0] : null;
}

/**
 * AI가 낸 가격을 그대로 화면에 띄우지 않고 정제한다.
 *
 * 두 가지 실제 위험을 막는다.
 *  1) 호가 미적용 — 엔진 가격은 lib/tick.ts로 실주문 가능한 값에 맞췄지만, AI가 낸 숫자는
 *     그 경로를 타지 않는다. UI는 `ai?.stopPrice ?? sig.stopPrice`처럼 AI 값을 우선하므로,
 *     정제하지 않으면 화면에 다시 "주문 불가한 가격"이 뜬다.
 *  2) 근거 없는 값 — 토큰 절약으로 한 줄만 전달된(관망) 종목은 AI가 손절가·목표가를 알 수 없다.
 *     그런데도 스키마상 필드는 채울 수 있어 지어낼 여지가 있다. 그런 종목은 가격 필드를 비워
 *     엔진이 계산한 값(검증된 ATR 기반)이 그대로 쓰이게 한다.
 */
function sanitizeAdvicePrices(
  advice: Omit<AiAdvice, "generatedAt">,
  signals: EngineSignal[],
  quietTickers: Set<string>,
): Omit<AiAdvice, "generatedAt"> {
  const byTicker = new Map(signals.map((s) => [s.ticker as string, s]));
  const stocks = (advice.stocks ?? []).map((st) => {
    const sig = byTicker.get(st.ticker);
    if (!sig) return st;
    if (quietTickers.has(st.ticker)) {
      // 상세 데이터를 안 줬으므로 가격 판단도 받지 않는다 — 엔진 값으로 대체된다
      return { ...st, entryPrice: null, targetPrice: null, stopPrice: null };
    }
    const cur = STOCKS[sig.ticker].currency;
    const fix = (v: number | null | undefined, mode: "nearest" | "up" | "down") =>
      v == null || !isFinite(v) || v <= 0 ? null : roundToTick(v, cur, mode);
    return {
      ...st,
      entryPrice: fix(st.entryPrice, "nearest"),
      // 손절은 올림(리스크가 계산치를 넘지 않게), 목표는 내림(도달 가능성 보수적) — 엔진과 같은 규칙
      stopPrice: fix(st.stopPrice, "up"),
      targetPrice: fix(st.targetPrice, "down"),
    };
  });
  return { ...advice, stocks };
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
    const unit = STOCKS[sig.ticker].currency === "USD" ? "$" : "원";
    const fmtPrice = (n: number) => (unit === "$" ? `$${n.toLocaleString()}` : `${n.toLocaleString()}원`);
    const warnings: string[] = [];
    if (stock.entryPrice != null && sig.suggestedEntryPrice) {
      const diffPct = (Math.abs(stock.entryPrice - sig.suggestedEntryPrice) / sig.suggestedEntryPrice) * 100;
      if (diffPct > CONSISTENCY_DIVERGENCE_PCT) {
        warnings.push(
          `⚠️ AI 매수 진입가(${fmtPrice(stock.entryPrice)})가 룰 엔진 1차 계산값(${fmtPrice(sig.suggestedEntryPrice)})과 ${diffPct.toFixed(0)}% 차이 — 근거 재확인 필요`,
        );
      }
    }
    if (stock.targetPrice != null && sig.targetPrice) {
      const diffPct = (Math.abs(stock.targetPrice - sig.targetPrice) / sig.targetPrice) * 100;
      if (diffPct > CONSISTENCY_DIVERGENCE_PCT) {
        warnings.push(
          `⚠️ AI 목표가(${fmtPrice(stock.targetPrice)})가 룰 엔진 1차 계산값(${fmtPrice(sig.targetPrice)})과 ${diffPct.toFixed(0)}% 차이 — 근거 재확인 필요`,
        );
      }
    }
    if (stock.stopPrice != null && sig.stopPrice) {
      const diffPct = (Math.abs(stock.stopPrice - sig.stopPrice) / sig.stopPrice) * 100;
      if (diffPct > CONSISTENCY_DIVERGENCE_PCT) {
        warnings.push(
          `⚠️ AI 손절가(${fmtPrice(stock.stopPrice)})가 룰 엔진 1차 계산값(${fmtPrice(sig.stopPrice)})과 ${diffPct.toFixed(0)}% 차이 — 근거 재확인 필요`,
        );
      }
    }
    if (stock.actionScore != null) {
      // 보유 중이라도 action이 "추가매수"(피라미딩)면 매도강도가 아니라 매수강도(buyStrength)가 기준이다.
      const isHoldingSellJudgment = sig.pnlPct != null && stock.action !== "추가매수";
      const engineScore = isHoldingSellJudgment ? sig.sellStrength : sig.buyStrength;
      if (engineScore != null && Math.abs(stock.actionScore - engineScore) > ACTION_SCORE_DIVERGENCE) {
        const label = isHoldingSellJudgment ? "매도" : "매수";
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
        "당신은 한국 주식 단타 트레이딩 전문가입니다. 국내 10종목(반도체 5 + 방산·자동차·금융·바이오·통신 5) 투자자를 위한 짧은 시장 브리핑을 작성하세요. 형식: 이모지 포함 순수 텍스트(마크다운 금지). 종목마다 1줄로: 매수/매도 강도(0~10점) + 지금 필요한 구체적 행동(진입 트리거 또는 손절가, 통화 단위 정확히). 강도 6점 이상인 종목만 우선 언급하고 나머지는 종목명만 나열해도 된다. 반도체와 비반도체를 구분해서 정리한다. VIX나 공포탐욕지수가 경계 수준이면 한 줄로 언급. 마지막에 주요 뉴스/리스크 한 줄.",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            장상태_국내: params.signals.find((s) => STOCKS[s.ticker].market === "KR")?.marketPhase ?? null,
            장상태_미국: params.signals.find((s) => STOCKS[s.ticker].market === "US")?.marketPhase ?? null,
            신호: params.signals.map((s) => ({
              종목: s.name,
              통화: STOCKS[s.ticker].currency === "USD" ? "달러" : "원",
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
              국제유가_WTI: fmtQ(params.macro.oil),
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
