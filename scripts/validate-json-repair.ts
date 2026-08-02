// AI 응답이 중간에 끊겼을 때 얼마나 살려내는지 검증한다.
//
// 실제 사고: max_tokens에 걸려 응답이 문자열 한가운데서 끝났고
// "Unterminated string in JSON at position 8202"로 JSON.parse가 통째로 실패해
// 이미 완성돼 있던 종목 판단까지 전부 버려졌다.
//
// 여기서는 완전한 응답을 만들어 모든 위치에서 한 글자씩 잘라보며,
// (1) 절대 예외를 던지지 않고 (2) 살릴 수 있는 종목은 최대한 살리고
// (3) 잘못된(반쯤 끊긴) 종목은 절대 통과시키지 않는지 확인한다.
import { parseAdviceResponse } from "../lib/claude";

const TICKERS = ["005930", "000660", "042700", "009150", "000990", "012450", "005380", "105560", "068270", "030200"];

function fullResponse(): string {
  return JSON.stringify({
    overall: {
      marketComment: "환율 1,412원, SOX -2.4%로 위험자산에 비우호적인 하루입니다.",
      riskLevel: "높음",
      headline: "오늘은 신규 진입보다 손절선 관리가 우선이에요",
      timeContext: "장중 10시 20분 — 개장 변동성이 아직 남아 있는 구간이에요",
    },
    insightReport: {
      marketRegime: "오늘은 한 방향으로 밀리는 흐름이에요. 환율이 1,412원까지 올라 외국인 매수에 불리해요.",
      technicalSynthesis: "10종목 중 6개가 20일선 아래예요. 특히 반도체 5종목이 같이 밀리고 있어요.",
      flowAndSentiment: "외국인은 이틀째 순매도예요. 뉴스는 악재가 12건 대 호재 3건으로 기울어 있어요.",
      keyRisks: "지금 따라 사면 고점에 물릴 위험이 커요. 반도체에만 몰아넣으면 사실상 한 종목이에요.",
      actionPlan: "삼성전기부터 보세요. 손절선이 이미 깨졌어요. 그다음 SK하이닉스 순서예요.",
    },
    stocks: TICKERS.map((t, i) => ({
      ticker: t,
      action: i === 0 ? "손절" : i < 4 ? "관망" : "보유",
      confidence: "중간",
      actionScore: (i * 3) % 11,
      timeHorizon: "당일",
      headline: `${t} 지금은 서두를 자리가 아니에요 (${i}번째 종목)`,
      rationale: [
        "20일선 아래에서 반등 근거가 아직 안 보여요(현재가가 평균선보다 3.2% 낮아요).",
        "거래량이 20일 평균의 62%로 말라 있어 방향을 확인하기 어려워요.",
      ],
      entryPrice: 70000 + i * 100,
      targetPrice: 74000 + i * 100,
      stopPrice: 68000 + i * 100,
      checklist: ["주문 직전 증권사 앱에서 최신가를 다시 확인하세요"],
      entryTriggers: [`${69000 + i * 100}원 지지 확인 후 분할 진입`],
      invalidation: `${67500 + i * 100}원 이탈 시 매매 논리 자체가 무효예요`,
    })),
    newsHighlights: ["SOX -2.4% 급락", "환율 1,412원 돌파"],
  });
}

const full = fullResponse();
console.log(`완전한 응답 길이: ${full.length}자 (실제 사고는 8,202자에서 끊김)`);

// 1) 온전한 응답은 그대로 통과해야 한다
{
  const r = parseAdviceResponse(full, "end_turn");
  if (r.truncated || !r.advice || r.advice.stocks.length !== 10) {
    console.error("❌ 정상 응답을 잘못 처리했습니다:", { truncated: r.truncated, n: r.advice?.stocks.length });
    process.exit(1);
  }
  console.log("✅ 정상 응답 — 종목 10개 그대로 통과, 복구 플래그 없음");
}

// 2) 모든 절단 위치에서 예외 없이, 살릴 수 있는 만큼 살려야 한다
let threw = 0;
let recovered = 0;
let gaveUp = 0;
let badStock = 0;
let maxStocks = 0;
const VALID_ACTIONS = new Set(["신규매수", "추가매수", "보유", "부분매도", "전량매도", "손절", "관망"]);

for (let cut = 1; cut < full.length; cut++) {
  const partial = full.slice(0, cut);
  let r;
  try {
    r = parseAdviceResponse(partial, "max_tokens");
  } catch (e) {
    threw++;
    if (threw <= 3) console.error(`  예외 발생 (cut=${cut}):`, (e as Error).message);
    continue;
  }
  if (!r.advice) {
    gaveUp++;
    continue;
  }
  recovered++;
  maxStocks = Math.max(maxStocks, r.advice.stocks.length);
  // 복구된 종목은 반드시 화면에 띄워도 되는 완전한 형태여야 한다
  for (const st of r.advice.stocks) {
    if (!st.ticker || !TICKERS.includes(st.ticker) || !VALID_ACTIONS.has(st.action) || !st.headline) {
      badStock++;
      if (badStock <= 3) console.error(`  불완전 종목 통과 (cut=${cut}):`, JSON.stringify(st).slice(0, 120));
    }
  }
  // 총평 없이 통과시키면 화면에 빈 카드가 뜬다
  if (!r.advice.overall?.headline) {
    console.error(`  총평 없이 통과 (cut=${cut})`);
    badStock++;
  }
}

console.log(`\n절단 위치 ${full.length - 1}곳 전수 테스트`);
console.log(`  예외 발생        : ${threw}건`);
console.log(`  부분 복구 성공   : ${recovered}건 (최대 ${maxStocks}종목까지 살림)`);
console.log(`  복구 포기(정상)  : ${gaveUp}건 — 총평조차 오기 전에 끊긴 구간`);
console.log(`  불완전 데이터 통과: ${badStock}건`);

// 3) 실제 사고와 같은 지점(문자열 한가운데)에서 끊긴 경우
{
  const idx = full.indexOf('"headline"', full.indexOf('"stocks"'));
  const partial = full.slice(0, idx + 40); // 헤드라인 문자열 도중에서 끊김
  const r = parseAdviceResponse(partial, "max_tokens");
  console.log(`\n문자열 한가운데 절단 재현: 복구=${!!r.advice} 종목=${r.advice?.stocks.length ?? 0}개 truncated=${r.truncated}`);
  if (!r.advice) {
    console.error("❌ 총평·인사이트가 온전한데도 전부 버렸습니다");
    process.exit(1);
  }
}

// 4) 복구 불가능한 쓰레기 입력
for (const junk of ["", "not json at all", "{", '{"overall":', "[[[["]) {
  const r = parseAdviceResponse(junk, "max_tokens");
  if (r.advice) {
    console.error(`❌ 쓰레기 입력을 통과시켰습니다: ${JSON.stringify(junk)}`);
    process.exit(1);
  }
}
console.log("✅ 복구 불가 입력은 전부 실패로 처리 (화면에는 재시도 안내가 뜬다)");

if (threw > 0 || badStock > 0) {
  console.error("\n❌ 실패");
  process.exit(1);
}
console.log("\n✅ 전체 통과 — 어디서 끊겨도 예외 없이, 완전한 종목만 살려냅니다.");
