// 전일까지의 외국인/기관 순매수(수급) 데이터를 KRX(한국거래소)의 공식 공개 데이터에서 가져온다.
// data.krx.co.kr의 getJsonData.cmd는 별도 API 키/가입 없이 누구나 호출 가능한 공개 엔드포인트로,
// pykrx 등 널리 쓰이는 오픈소스 라이브러리들이 실제로 사용하는 것과 동일한 방식이다.
// (실시간 체결 기준 수급이 아니라 "전일까지 확정된" 일별 수치 — 증권사 API 인증 없이 얻을 수 있는
// 가장 신뢰도 높은 공개 소스다). KRX는 한국 거래소이므로 국내 상장 종목에만 적용하고,
// 테슬라/엔비디아 등 미국 종목은 대상에서 제외한다.
import type { InvestorFlowDay, StockTicker } from "./types";
import { KR_TICKERS } from "./types";

const KRX_URL = "http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REFERER = "http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020101";

async function krxPost(bld: string, params: Record<string, string | number>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ bld, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const res = await fetch(KRX_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: REFERER,
    },
    body: body.toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`KRX 요청 실패: HTTP ${res.status}`);
  return res.json();
}

let isinCache: { map: Map<string, string>; expiresAt: number } | null = null;
const ISIN_TTL_MS = 24 * 3600_000; // ISIN(종목코드)은 사실상 안 바뀌므로 하루만 캐시해도 충분

// 6자리 KRX 종목코드를 12자리 ISIN(예: 005930 -> KR7005930003)으로 변환한다.
// ISIN 체크섬을 직접 계산하지 않고, KRX 자체의 종목 검색(finder) 엔드포인트로 조회해
// 하드코딩 오류 가능성을 없앤다 (DART corp_code 처리와 동일한 원칙).
async function resolveIsin(ticker: string): Promise<string | null> {
  const now = Date.now();
  if (isinCache && isinCache.expiresAt > now) {
    const cached = isinCache.map.get(ticker);
    if (cached) return cached;
  }
  const json = await krxPost("dbms/comm/finder/finder_stkisu", {
    locale: "ko_KR",
    mktsel: "ALL",
    searchText: ticker,
    typeNo: 0,
  });
  const rows = (json.block1 ?? json.OutBlock_1 ?? json.output ?? []) as Record<string, unknown>[];
  const map = isinCache?.map ?? new Map<string, string>();
  for (const row of rows) {
    const shortCode = String(row.short_code ?? row.shortCode ?? "").trim();
    const fullCode = String(row.full_code ?? row.fullCode ?? "").trim();
    if (shortCode && fullCode) map.set(shortCode, fullCode);
  }
  isinCache = { map, expiresAt: now + ISIN_TTL_MS };
  return map.get(ticker) ?? null;
}

function parseKrxNumber(v: unknown): number {
  const n = Number(String(v ?? "0").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

// [12009] 투자자별 거래실적(개별종목) — trdVolVal=1(거래량 기준 주수), askBid=3(순매수)로 조회.
// 응답 컬럼은 TRD_DD(날짜)/TRDVAL1(기관합계)/TRDVAL2(기타법인)/TRDVAL3(개인)/TRDVAL4(외국인합계)/TRDVAL_TOT.
async function fetchInvestorTrend(isin: string, days = 7): Promise<InvestorFlowDay[]> {
  const endKst = new Date(Date.now() + 9 * 3600_000);
  const startKst = new Date(endKst.getTime() - days * 24 * 3600_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const json = await krxPost("dbms/MDC/STAT/standard/MDCSTAT02302", {
    strtDd: fmt(startKst),
    endDd: fmt(endKst),
    isuCd: isin,
    trdVolVal: 1,
    askBid: 3,
  });
  const rows = (json.output ?? []) as Record<string, unknown>[];
  return rows
    .map((r) => ({
      date: String(r.TRD_DD ?? "").replace(/\//g, "-"),
      institutionNet: parseKrxNumber(r.TRDVAL1),
      foreignNet: parseKrxNumber(r.TRDVAL4),
    }))
    .filter((r) => r.date)
    .reverse(); // KRX는 최신순으로 내려주므로 오래된 날짜부터 오도록 뒤집는다 (배열의 마지막 = 가장 최근)
}

let flowCache: { data: Partial<Record<StockTicker, InvestorFlowDay[]>>; expiresAt: number } | null = null;
const FLOW_CACHE_TTL_MS = 60 * 60_000; // 하루 1회 갱신되는 데이터라 1시간 캐시로 충분

// API 키가 필요 없는 공개 데이터라 항상 시도한다. 실패해도(엔드포인트 변경, 접근 차단 등)
// 조용히 빈 결과를 돌려줘 나머지 파이프라인(뉴스/기술적 지표/공시)은 영향받지 않는다.
export async function fetchInvestorFlows(): Promise<{ data: Partial<Record<StockTicker, InvestorFlowDay[]>>; error: string | null }> {
  const now = Date.now();
  if (flowCache && flowCache.expiresAt > now) return { data: flowCache.data, error: null };

  try {
    const result: Partial<Record<StockTicker, InvestorFlowDay[]>> = {};
    for (const ticker of KR_TICKERS) {
      try {
        const isin = await resolveIsin(ticker);
        if (!isin) {
          console.warn(`KRX ISIN을 찾지 못함: ${ticker}`);
          continue;
        }
        result[ticker] = await fetchInvestorTrend(isin);
      } catch (e) {
        console.error(`KRX 수급 조회 실패 (${ticker}):`, e);
        result[ticker] = [];
      }
      await new Promise((r) => setTimeout(r, 200)); // 연속 호출 간 짧은 간격 (배려)
    }
    flowCache = { data: result, expiresAt: now + FLOW_CACHE_TTL_MS };
    return { data: result, error: null };
  } catch (e) {
    const msg = `KRX 수급 연동 실패: ${String(e).slice(0, 200)}`;
    console.error(msg);
    flowCache = { data: {}, expiresAt: now + 5 * 60_000 };
    return { data: {}, error: msg };
  }
}
