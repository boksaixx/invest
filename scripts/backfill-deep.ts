// 삼성전자·SK하이닉스 2종목 심층 데이터 수집 — 예측 모델 학습·검증용 원천 데이터.
//
// 실행: npx tsx scripts/backfill-deep.ts   (GitHub Actions 주간 실행 + 최초 1회)
//
// 모으는 것 (전부 키 없는 공개 데이터)
//  · 일봉 OHLCV 2016~ : 삼성전자·SK하이닉스, SOX·마이크론(MU)·엔비디아(NVDA)·나스닥 종합·나스닥100 선물·원달러·코스피
//  · 1시간봉 최근 2년 : 2종목 (야후 60분봉 최대 730일) — "장중 이 시각에 이 상태면 마감까지 어땠나"를 재는 데 쓴다.
//    야후가 2년치만 주므로 기존 파일과 병합해 시간이 갈수록 쌓이게 한다.
//  · 투자자별 순매수 2019~ : 외국인·기관·개인 일별 순매수 주수 + 외국인 보유율 (네이버 증권)
//    ※ 예전 KRX 공개 엔드포인트는 2025년부터 로그인을 요구해("LOGOUT") 수급이 늘 빈값이었다.
//
// 결과: data/deep-history.json — scripts/train-model.ts 가 읽어 data/model.json 을 만든다.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const OUT = join(process.cwd(), "data", "deep-history.json");

export const DEEP_STOCKS = { "005930": "005930.KS", "000660": "000660.KS" } as const;
export const DEEP_US = { sox: "^SOX", mu: "MU", nvda: "NVDA", nq: "NQ=F", ndx: "^IXIC", usdkrw: "KRW=X", kospi: "^KS11" } as const;

export type DailyBar = { d: string; o: number; h: number; l: number; c: number; v: number };
export type HourBar = { t: string; o: number; h: number; l: number; c: number; v: number }; // t = KST "YYYY-MM-DD HH:mm"
export type FlowDay = { d: string; foreign: number; inst: number; indiv: number; foreignHoldPct: number | null };
export interface DeepHistory {
  generatedAt: string;
  daily: Record<string, DailyBar[]>; // 키: 종목코드 또는 DEEP_US 키
  hourly: Record<string, HourBar[]>;
  flows: Record<string, FlowDay[]>;
}

async function yahoo(symbol: string, params: string): Promise<{ ts: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; gmtoffset: number } | null> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const res = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}&includePrePost=false`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const j = await res.json();
      const r = j?.chart?.result?.[0];
      if (!r?.timestamp) continue;
      const q = r.indicators.quote[0];
      return { ts: r.timestamp, o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume, gmtoffset: r.meta?.gmtoffset ?? 0 };
    } catch {
      // 다음 호스트
    }
  }
  return null;
}

async function fetchDaily(symbol: string, fromIso = "2016-01-01"): Promise<DailyBar[]> {
  const p1 = Math.floor(new Date(fromIso).getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const r = await yahoo(symbol, `period1=${p1}&period2=${p2}&interval=1d`);
  if (!r) return [];
  const out: DailyBar[] = [];
  for (let i = 0; i < r.ts.length; i++) {
    const [o, h, l, c, v] = [r.o[i], r.h[i], r.l[i], r.c[i], r.v[i]];
    if (o == null || h == null || l == null || c == null || !(c > 0)) continue;
    // 거래소 현지 날짜로 (야후 일봉 타임스탬프는 현지 개장 시각)
    const d = new Date((r.ts[i] + r.gmtoffset) * 1000).toISOString().slice(0, 10);
    out.push({ d, o, h, l, c, v: v ?? 0 });
  }
  // 같은 날짜 중복(진행 중인 봉 등) 제거 — 마지막 값 우선
  const m = new Map(out.map((b) => [b.d, b]));
  return [...m.values()].sort((a, b) => a.d.localeCompare(b.d));
}

async function fetchHourly(symbol: string): Promise<HourBar[]> {
  const r = await yahoo(symbol, "range=730d&interval=60m");
  if (!r) return [];
  const out: HourBar[] = [];
  for (let i = 0; i < r.ts.length; i++) {
    const [o, h, l, c, v] = [r.o[i], r.h[i], r.l[i], r.c[i], r.v[i]];
    if (o == null || h == null || l == null || c == null || !(c > 0)) continue;
    const t = new Date((r.ts[i] + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ");
    out.push({ t, o, h, l, c, v: v ?? 0 });
  }
  return out;
}

const num = (s: unknown) => {
  const n = Number(String(s ?? "").replace(/[,+%]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

async function fetchFlows(code: string, fromIso = "2019-01-01"): Promise<FlowDay[]> {
  const out: FlowDay[] = [];
  let bizdate = ""; // 첫 페이지는 최신부터 (미래 날짜를 주면 빈 배열이 온다)
  const stop = fromIso.replace(/-/g, "");
  for (let page = 0; page < 60; page++) {
    let rows: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=60${bizdate ? `&bizdate=${bizdate}` : ""}`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          rows = (await res.json()) as Record<string, unknown>[];
          break;
        }
      } catch {
        // 재시도
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const d = String(r.bizdate ?? "");
      if (d.length !== 8) continue;
      out.push({
        d: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        foreign: num(r.foreignerPureBuyQuant),
        inst: num(r.organPureBuyQuant),
        indiv: num(r.individualPureBuyQuant),
        foreignHoldPct: r.foreignerHoldRatio != null ? num(r.foreignerHoldRatio) : null,
      });
    }
    const oldest = String(rows[rows.length - 1].bizdate);
    if (oldest <= stop) break;
    bizdate = oldest; // 이 날짜 "이전"부터 다음 페이지 (bizdate 당일은 제외되어 내려온다)
    await new Promise((r) => setTimeout(r, 250));
  }
  const m = new Map(out.map((f) => [f.d, f]));
  return [...m.values()].filter((f) => f.d >= fromIso).sort((a, b) => a.d.localeCompare(b.d));
}

function mergeBy<T>(prev: T[] | undefined, next: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of prev ?? []) m.set(key(x), x);
  for (const x of next) m.set(key(x), x); // 새 값 우선
  return [...m.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

async function main() {
  const prev: DeepHistory | null = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  const out: DeepHistory = { generatedAt: new Date().toISOString(), daily: {}, hourly: {}, flows: {} };

  for (const [code, sym] of Object.entries(DEEP_STOCKS)) {
    const [daily, hourly, flows] = await Promise.all([fetchDaily(sym), fetchHourly(sym), fetchFlows(code)]);
    out.daily[code] = daily.length ? mergeBy(prev?.daily[code], daily, (b) => b.d) : (prev?.daily[code] ?? []);
    out.hourly[code] = mergeBy(prev?.hourly[code], hourly, (b) => b.t);
    out.flows[code] = flows.length ? mergeBy(prev?.flows[code], flows, (f) => f.d) : (prev?.flows[code] ?? []);
    console.log(`${code}: 일봉 ${out.daily[code].length} (${out.daily[code][0]?.d}~) · 1시간봉 ${out.hourly[code].length} (${out.hourly[code][0]?.t}~) · 수급 ${out.flows[code].length} (${out.flows[code][0]?.d}~)`);
  }
  for (const [key, sym] of Object.entries(DEEP_US)) {
    const daily = await fetchDaily(sym);
    out.daily[key] = daily.length ? mergeBy(prev?.daily[key], daily, (b) => b.d) : (prev?.daily[key] ?? []);
    console.log(`${key}(${sym}): 일봉 ${out.daily[key].length}`);
  }
  // 용량을 줄이려고 가격은 소수 2자리로
  const round = <T extends Record<string, unknown>>(x: T) =>
    Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 100) / 100 : v])) as T;
  for (const k of Object.keys(out.daily)) out.daily[k] = out.daily[k].map(round);
  for (const k of Object.keys(out.hourly)) out.hourly[k] = out.hourly[k].map(round);
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`저장: ${OUT}`);
}

if (process.argv[1]?.endsWith("backfill-deep.ts")) main();
