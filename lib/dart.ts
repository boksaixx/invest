// DART(전자공시시스템) Open API로 국내 상장 종목의 최근 공식 공시를 가져온다.
// 추적 10종목이 전부 KRX 상장사라 모두 대상이다.
// 뉴스는 기자가 취재해 쓰는 만큼 필연적으로 한 박자 늦지만, 공시는 기업이 법적 의무로 직접
// 공식 채널에 올리는 원천 정보라 "정보의 시차" 문제를 근본적으로 줄여준다.
// DART_API_KEY 필요 (https://opendart.fss.or.kr 회원가입 후 무료 발급, 선택 기능 — 키가 없으면 조용히 비활성화).
import { inflateRawSync } from "node:zlib";
import { KR_TICKERS } from "./types";
import type { DartFiling, StockTicker } from "./types";

// 최소 zip 리더: 로컬 파일 헤더(PK\x03\x04)만 읽어 첫 번째 엔트리를 압축 해제한다.
// (DART의 corpCode.xml은 단일 파일 zip이라 중앙 디렉터리까지 파싱할 필요가 없다)
function unzipFirstEntry(buf: Buffer): Buffer | null {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  const method = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  if (compressedSize <= 0 || dataStart + compressedSize > buf.length) return null; // 스트리밍 데이터 디스크립터 등 미지원 형식
  const data = buf.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return Buffer.from(data); // 무압축 저장
  if (method === 8) return inflateRawSync(data); // deflate
  return null;
}

function parseCorpCodeXml(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const listRe = /<list>([\s\S]*?)<\/list>/g;
  let m: RegExpExecArray | null;
  while ((m = listRe.exec(xml))) {
    const block = m[1];
    const corpCode = /<corp_code>([^<]*)<\/corp_code>/.exec(block)?.[1]?.trim();
    const stockCode = /<stock_code>([^<]*)<\/stock_code>/.exec(block)?.[1]?.trim();
    if (corpCode && stockCode) map.set(stockCode, corpCode);
  }
  return map;
}

let corpCodeCache: { map: Map<string, string>; expiresAt: number } | null = null;
const CORP_CODE_TTL_MS = 24 * 3600_000; // 상장기업 코드는 거의 안 바뀌므로 하루만 캐시해도 충분

// 종목의 DART corp_code(8자리 고유번호)는 6자리 증권 티커와 다르다. 하드코딩하지 않고
// corpCode.xml(전체 상장사 목록)을 내려받아 stock_code(=우리 5종목의 6자리 티커) 기준으로
// 직접 찾는다 — 잘못된 코드를 하드코딩해 조용히 실패하는 것을 방지.
async function fetchCorpCodeMap(apiKey: string): Promise<Map<string, string>> {
  const now = Date.now();
  if (corpCodeCache && corpCodeCache.expiresAt > now) return corpCodeCache.map;

  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`DART corpCode 다운로드 실패: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    // zip이 아니면 DART가 에러를 XML/텍스트로 반환한 것 (API 키 오류 등)
    throw new Error(`DART corpCode 응답이 zip 형식이 아닙니다(API 키 확인 필요): ${buf.toString("utf8").slice(0, 200)}`);
  }
  const xmlBuf = unzipFirstEntry(buf);
  if (!xmlBuf) throw new Error("DART corpCode.xml 압축 해제 실패");
  const map = parseCorpCodeXml(xmlBuf.toString("utf8"));
  if (map.size === 0) throw new Error("DART corpCode.xml 파싱 결과가 비어 있음");
  corpCodeCache = { map, expiresAt: now + CORP_CODE_TTL_MS };
  return map;
}

// 공시 제목 키워드로만 판단하는 아주 단순한 긍/부정 분류 — 실제 공시 본문 내용까지는 분석하지
// 않으므로(list.json은 메타데이터만 제공) 참고용이며, 최종 해석은 Claude에게 맡긴다.
function classifyFilingSentiment(title: string): DartFiling["sentiment"] {
  const negative = ["유상증자", "전환사채", "신주인수권부사채", "감자", "관리종목", "불성실공시", "소송", "횡령", "배임", "적자전환", "영업정지", "상장폐지", "회생절차"];
  const positive = ["자기주식취득", "무상증자", "실적개선", "흑자전환", "자사주소각", "특허", "수주"];
  if (negative.some((k) => title.includes(k))) return "부정";
  if (positive.some((k) => title.includes(k))) return "긍정";
  return "중립";
}

async function fetchRecentDisclosures(apiKey: string, corpCode: string, days = 3): Promise<DartFiling[]> {
  const endKst = new Date(Date.now() + 9 * 3600_000);
  const startKst = new Date(endKst.getTime() - days * 24 * 3600_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const url =
    `https://opendart.fss.or.kr/api/list.json?crtfc_key=${apiKey}&corp_code=${corpCode}` +
    `&bgn_de=${fmt(startKst)}&end_de=${fmt(endKst)}&page_no=1&page_count=20`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`DART 공시 조회 실패: HTTP ${res.status}`);
  const json = (await res.json()) as { status: string; message?: string; list?: Record<string, unknown>[] };
  if (json.status === "013") return []; // 조회된 공시 없음 — 정상적인 "없음" 상태
  if (json.status !== "000") throw new Error(`DART API 오류(${json.status}): ${json.message ?? ""}`);
  return (json.list ?? [])
    .map((it) => ({
      title: String(it.report_nm ?? ""),
      date: String(it.rcept_dt ?? ""),
      reporterName: String(it.flr_nm ?? ""),
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${it.rcept_no ?? ""}`,
      sentiment: classifyFilingSentiment(String(it.report_nm ?? "")),
    }))
    .filter((f) => f.title);
}

// 추적 5종목 밖이지만 국내 반도체 밸류체인에 직접 영향을 주는 상장사들.
// 이들의 수주·실적·증설 공시는 삼성전자·SK하이닉스의 투자 사이클을 선행해서 보여주는 경우가 많다
// (장비주는 발주가 나야 매출이 잡히므로 발주 시점이 곧 대장주 CAPEX 신호).
// 5종목 공시가 조용한 날에도 밸류체인에서 무슨 일이 벌어지는지 알 수 있게 함께 조회한다.
export const RELATED_CORPS: { stockCode: string; name: string; role: string }[] = [
  { stockCode: "402340", name: "SK스퀘어", role: "SK하이닉스 지주사" },
  { stockCode: "240810", name: "원익IPS", role: "반도체 증착장비" },
  { stockCode: "036930", name: "주성엔지니어링", role: "반도체 증착장비" },
  { stockCode: "039030", name: "이오테크닉스", role: "레이저 장비(HBM 공정)" },
  { stockCode: "058470", name: "리노공업", role: "테스트 부품" },
  { stockCode: "064760", name: "티씨케이", role: "소모성 부품" },
];

let disclosureCache: { data: Partial<Record<StockTicker, DartFiling[]>>; expiresAt: number } | null = null;
let relatedCache: { data: RelatedFiling[]; expiresAt: number } | null = null;

export interface RelatedFiling extends DartFiling {
  companyName: string;
  role: string;
}
const DISCLOSURE_CACHE_TTL_MS = 15 * 60_000; // 자동수집 간격과 맞춤

// DART_API_KEY가 없으면 조용히 빈 결과를 돌려준다 — 선택 기능이라 에러로 취급하지 않는다
// (기존 뉴스/시세 파이프라인은 이 기능 없이도 완전히 동작해야 한다).
export async function fetchDartDisclosures(): Promise<{ data: Partial<Record<StockTicker, DartFiling[]>>; error: string | null }> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return { data: {}, error: null };

  const now = Date.now();
  if (disclosureCache && disclosureCache.expiresAt > now) return { data: disclosureCache.data, error: null };

  try {
    const corpMap = await fetchCorpCodeMap(apiKey);
    const result: Partial<Record<StockTicker, DartFiling[]>> = {};
    for (const ticker of KR_TICKERS) {
      const corpCode = corpMap.get(ticker);
      if (!corpCode) {
        console.warn(`DART corp_code를 찾지 못함: ${ticker}`);
        continue;
      }
      try {
        result[ticker] = await fetchRecentDisclosures(apiKey, corpCode);
      } catch (e) {
        console.error(`DART 공시 조회 실패 (${ticker}):`, e);
        result[ticker] = [];
      }
      await new Promise((r) => setTimeout(r, 250)); // 연속 호출 간 짧은 간격 (배려)
    }
    disclosureCache = { data: result, expiresAt: now + DISCLOSURE_CACHE_TTL_MS };
    return { data: result, error: null };
  } catch (e) {
    const msg = `DART 연동 실패: ${String(e).slice(0, 200)}`;
    console.error(msg);
    // 실패해도 짧게 캐시해 연속 재시도로 API를 낭비하지 않음
    disclosureCache = { data: {}, expiresAt: now + 60_000 };
    return { data: {}, error: msg };
  }
}


/**
 * 밸류체인 관련 기업들의 최근 공시.
 *
 * 5종목만 보면 "장비 발주가 시작됐다" 같은 선행 신호를 놓친다. 다만 이건 보조 정보라
 * 실패해도 조용히 빈 배열을 돌려주고, 중요도가 낮은 정기공시는 걸러 토큰·화면을 아낀다.
 */
export async function fetchRelatedDisclosures(): Promise<RelatedFiling[]> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return [];
  const now = Date.now();
  if (relatedCache && relatedCache.expiresAt > now) return relatedCache.data;

  try {
    const corpMap = await fetchCorpCodeMap(apiKey);
    const out: RelatedFiling[] = [];
    for (const { stockCode, name, role } of RELATED_CORPS) {
      const corpCode = corpMap.get(stockCode);
      if (!corpCode) continue;
      try {
        const filings = await fetchRecentDisclosures(apiKey, corpCode, 3);
        for (const f of filings) out.push({ ...f, companyName: name, role });
      } catch {
        // 개별 실패는 무시 — 보조 정보라 전체를 막을 이유가 없다
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // 판단에 쓸모 있는 공시만 남긴다 (정기보고서·소액 지분변동 등은 단타 판단에 무의미)
    const MATERIAL = /수주|공급계약|증설|투자|실적|영업[(잠정)]*|유상증자|무상증자|자기주식|합병|분할|특허|계약\s*체결|매출/;
    const filtered = out.filter((f) => MATERIAL.test(f.title));
    relatedCache = { data: filtered.slice(0, 12), expiresAt: now + DISCLOSURE_CACHE_TTL_MS };
    return relatedCache.data;
  } catch (e) {
    console.error("DART 관련기업 공시 조회 실패:", e);
    relatedCache = { data: [], expiresAt: now + 60_000 };
    return [];
  }
}
