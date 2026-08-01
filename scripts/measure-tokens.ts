// Claude 입력 토큰 실측 — data/latest.json의 실제 신호로 페이로드를 만들어 크기를 잰다.
//
// 실행: npx tsx scripts/measure-tokens.ts
//
// ANTHROPIC_API_KEY가 있으면 Anthropic 공식 count_tokens API로 정확히 세고,
// 없으면 문자수 기반으로 근사한다(한국어+JSON 혼합은 대략 2.2자/토큰).
//
// 페이로드 구조를 바꿀 때마다 이 스크립트를 돌려 "정보는 유지하면서 토큰만 줄었는지" 확인할 것.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { buildAdvicePayload } from "../lib/claude";
import type { CollectedSnapshot } from "../lib/types";
import { STOCKS } from "../lib/types";

const CHARS_PER_TOKEN = 2.2;

// 최적화 이전 페이로드 형태 — 비교 기준선으로만 쓰는 재현본.
function legacyPayload(snap: CollectedSnapshot) {
  return {
    현재시각_KST: new Date().toISOString(),
    장상태_국내: null,
    장상태_미국: null,
    상대강도_랭킹: null,
    섹터집중도_경고: null,
    포트폴리오: { cash: 20000000, cashUSD: 0, holdings: [] },
    룰엔진_신호: (snap.signals ?? []).map((s) => ({
      종목: s.name,
      ticker: s.ticker,
      통화: "원",
      현재가: s.price,
      엔진판단: s.action,
      점수: s.score,
      보유중여부: s.pnlPct != null,
      엔진_매수강도_0to10: s.buyStrength,
      엔진_매도강도_0to10: s.sellStrength,
      엔진_판정문: s.verdict,
      매크로_영향도점수: s.macroScore,
      최근공시: s.disclosures.length > 0 ? s.disclosures.slice(0, 3).map((d) => `[${d.sentiment}] ${d.title} (${d.date})`) : "최근 공시 없음",
      전일까지_외국인기관수급_주:
        s.investorFlow.length > 0
          ? s.investorFlow.slice(-3).map((f) => `${f.date}: 외국인 ${f.foreignNet} / 기관 ${f.institutionNet}`)
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
        ? { 표본수: s.backtest.sampleSignals, "5일후_승률": `${s.backtest.winRate5d}%`, "5일후_평균수익률": `${s.backtest.avgReturn5d}%` }
        : "백테스트 데이터 없음",
      일봉지표: {
        RSI14: s.indicators.rsi14,
        MA5: s.indicators.ma5,
        MA20: s.indicators.ma20,
        MA60: s.indicators.ma60,
        거래량Z점수: s.indicators.volumeZ,
        거래량_기준일: "가장 최근 거래일(마감)",
        거래량_주: Math.round(s.indicators.lastVolume).toLocaleString(),
        "20일평균거래량_주": Math.round(s.indicators.avgVolume20).toLocaleString(),
        "20일평균대비": "0%",
        "스토캐스틱_%K": s.indicators.stochK,
        "스토캐스틱_%D": s.indicators.stochD,
        피벗_R1: s.indicators.pivotR1,
        피벗_S1: s.indicators.pivotS1,
        ADX_추세강도: `${s.indicators.adx14} (추세장)`,
        변동성_레짐: `${s.indicators.volatilityRatio}배 (평소 수준)`,
        RSI강세다이버전스: s.indicators.bullishDivergence,
        RSI약세다이버전스: s.indicators.bearishDivergence,
        해머형반전캔들: s.indicators.hammerReversal,
        OBV다이버전스: s.indicators.obvDivergence,
      },
      장중지표: s.intraday?.available
        ? {
            VWAP: s.intraday.vwap,
            VWAP대비: `${s.intraday.distanceFromVwapPct}%`,
            갭: `${s.intraday.gapType} ${s.intraday.gapPct}%`,
            오프닝레인지상태: s.intraday.orbStatus,
            당일모멘텀: s.intraday.momentum,
          }
        : "장중 데이터 수집 실패 (일봉 기준으로만 판단)",
    })),
    매크로: snap.macro,
    최신뉴스: snap.news.slice(0, 10),
    직전_자동수집_요약: snap.aiSummary,
    과거_주요이벤트_참고: [],
  };
}

async function main() {
  const snap = JSON.parse(readFileSync(join(process.cwd(), "data", "latest.json"), "utf8")) as CollectedSnapshot;
  // 자동수집 스냅샷에는 종목 구성이 바뀌기 전의 옛 종목이 남아있을 수 있어 현재 종목만 남긴다.
  if (snap.signals) snap.signals = snap.signals.filter((s) => s.ticker in STOCKS);
  if (!snap.signals?.length) {
    console.error("data/latest.json에 (현재 종목 기준) signals가 없습니다.");
    process.exit(1);
  }

  const events = JSON.parse(readFileSync(join(process.cwd(), "data", "events.json"), "utf8")) as {
    events: { date: string; title: string; note: string }[];
  };

  // 최악 케이스로 측정한다 — 폭락장 레짐 + 트레이드 2개 + 보유자 지침 + 신용잔고까지 실린 상태.
  const worstCasePlan = {
    regime: "폭락장" as const,
    regimeNote: "간밤 미 반도체지수(SOX) -5.2% 폭락, 삼성전자 -8.8% 폭락 중",
    trades: snap.signals.slice(0, 2).map((s) => ({
      kind: "폭락반등매수" as const,
      ticker: s.ticker,
      name: s.name,
      currency: "KRW" as const,
      currentPrice: s.price,
      entryPrice: s.price,
      targetPrice: null,
      stopPrice: null,
      sellLimitPrice: null,
      sigmaDailyPct: 8,
      suggestedQty: 8,
      suggestedBudget: 2_000_000,
      headline: "마감 동시호가(15:20~15:30) 소액 분할 매수 → 내일 종가 부근 청산",
      rationale: "당일 -8.8% 폭락 — 5년 실측상 -8%↓ 폭락 마감 후 익일 평균 +1.4%, 승률 64~65%",
      cautions: ["13.6% 확률로 연속 폭락 전례 — 총자산 10% 이내 소액만"],
    })),
    holderGuide: [
      "갭하락 시가에 패닉 매도하지 마세요 — 실측상 시가 매도 후 재매수는 그냥 보유 대비 평균 -0.13%p로 이득이 없었습니다.",
      "기존 손절선은 예외 없이 지키되, 손절선 위라면 장중 투매에 휩쓸리지 말 것.",
    ],
    marketNote: "폭락장 플레이북 — 반등 통계가 있는 자리만 소액으로 노리고, 나머지는 원칙 방어.",
    skippedNote: null,
  };

  const next = buildAdvicePayload({
    signals: snap.signals,
    macro: snap.macro,
    news: snap.news,
    portfolio: { cash: 20_000_000, cashUSD: 0, holdings: [] },
    history: snap,
    events: events.events,
    relativeStrengthSummary: null,
    sectorConcentrationWarning: null,
    todayPlan: worstCasePlan,
    creditNote: "신용융자 잔고 24.8조원 — 최근 20일 새 18% 급증. 빚투가 몰린 상태라 급락 시 반대매매 연쇄로 하락이 증폭될 수 있음",
  });

  const legacyStr = JSON.stringify(legacyPayload(snap), null, 1);
  const nextStr = JSON.stringify(next);

  const key = process.env.ANTHROPIC_API_KEY;
  let count: (s: string) => Promise<number>;
  if (key) {
    const client = new Anthropic({ apiKey: key });
    count = async (s: string) => {
      const r = await client.messages.countTokens({
        model: process.env.CLAUDE_MODEL || "claude-opus-4-8",
        messages: [{ role: "user", content: s }],
      });
      return r.input_tokens;
    };
    console.log("측정 방식: Anthropic count_tokens API (정확)\n");
  } else {
    count = async (s: string) => Math.round(s.length / CHARS_PER_TOKEN);
    console.log(`측정 방식: 문자수 근사 (${CHARS_PER_TOKEN}자/토큰) — ANTHROPIC_API_KEY 설정 시 정확한 값 측정\n`);
  }

  const legacyTok = await count(legacyStr);
  const nextTok = await count(nextStr);

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`${pad("항목", 22)}${pad("문자수", 12)}토큰(추정)`);
  console.log("-".repeat(48));
  console.log(`${pad("최적화 전 페이로드", 20)}${pad(legacyStr.length.toLocaleString(), 12)}${legacyTok.toLocaleString()}`);
  console.log(`${pad("최적화 후(작전 포함)", 20)}${pad(nextStr.length.toLocaleString(), 12)}${nextTok.toLocaleString()}`);
  const saved = legacyTok - nextTok;
  console.log(
    `\n절감: ${saved.toLocaleString()} 토큰 (${((saved / legacyTok) * 100).toFixed(1)}%)`,
  );

  // 필드별 비중 — 어디가 무거운지 파악해 다음 최적화 지점을 찾는다
  console.log("\n=== 최적화 후 상위 항목별 비중 ===\n");
  const entries = Object.entries(next).map(([k, v]) => [k, JSON.stringify(v)?.length ?? 0] as [string, number]);
  entries.sort((a, b) => b[1] - a[1]);
  for (const [k, len] of entries.slice(0, 8)) {
    console.log(`  ${pad(k, 22)} ${String(len).padStart(7)}자 (${((len / nextStr.length) * 100).toFixed(1)}%)`);
  }

  // 종목당 평균 — 종목이 늘어날 때 비용이 얼마나 늘지 예측
  const perStock = JSON.stringify((next as { 룰엔진_신호?: unknown[] }).룰엔진_신호 ?? []).length / (snap.signals?.length ?? 1);
  console.log(`\n종목 1개당 평균 ${Math.round(perStock).toLocaleString()}자 (약 ${Math.round(perStock / CHARS_PER_TOKEN)}토큰)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
