// 시장 전체 신용거래융자 잔고(빚투 규모) — 금융투자협회(KOFIA) 공개 통계 조회 시도.
//
// 왜 보는가: 신용잔고가 단기간 급증한 상태에서 급락이 오면 "반대매매(강제청산) 연쇄"가
// 하락을 증폭시킨다 — 요즘 같은 급변동장에서 하방 꼬리를 두껍게 만드는 대표 요인이다.
// 반대로 신용잔고가 크게 줄었다면 강제청산 물량이 이미 소진돼 바닥 신호로도 읽힌다.
//
// 데이터 소스의 한계(정직하게): KOFIA freesis는 공식 API가 아니라 화면용 엔드포인트라
// 스키마가 예고 없이 바뀔 수 있다. 그래서 이 모듈은 실패를 전제로 설계한다 —
// 어떤 오류든 조용히 null을 돌려주고, 엔진은 이 신호 없이 정상 동작한다.
// 연동 상태는 응답의 creditBalance 필드가 null인지로 확인할 수 있다.

export interface CreditBalanceTrend {
  latestDate: string; // YYYY-MM-DD
  latestTrillionKrw: number; // 최신 신용융자 잔고 (조원)
  change20dPct: number; // 20영업일 전 대비 증감률 (%)
  note: string; // 사람이 읽는 요약 한 줄
}

const KOFIA_URL = "https://freesis.kofia.or.kr/meta/getMetaDataList.do";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let cache: { data: CreditBalanceTrend | null; expiresAt: number } | null = null;
const TTL_OK_MS = 6 * 3600_000; // 하루 1회 갱신 데이터 — 성공 시 6시간 캐시
const TTL_FAIL_MS = 30 * 60_000; // 실패 시 30분 후 재시도

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function fetchCreditBalanceTrend(): Promise<CreditBalanceTrend | null> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.data;

  try {
    const end = new Date(now + 9 * 3600_000);
    const start = new Date(end.getTime() - 45 * 24 * 3600_000); // 20영업일 확보를 위해 45일 조회
    // STATSCU0100000060BO = 신용공여 현황(융자잔고) 화면. freesis 화면이 실제로 보내는 요청 형식.
    const res = await fetch(KOFIA_URL, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        dmSearch: {
          tmpV40: "1000000",
          tmpV41: "1",
          tmpV1: "12",
          tmpV45: fmtDate(start),
          tmpV46: fmtDate(end),
          OBJ_NM: "STATSCU0100000060BO",
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;

    // 응답 골격: { ds1: [{ TMPV1: "2026.07.30", TMPV2: "20,123,456", ... }] } 형태.
    // 스키마 변동 가능성이 있어 "날짜로 보이는 필드 + 가장 큰 숫자 필드"를 방어적으로 찾는다.
    const rows = (json.ds1 ?? json.ds2 ?? []) as Record<string, unknown>[];
    if (!Array.isArray(rows) || rows.length < 21) throw new Error(`행 부족 (${Array.isArray(rows) ? rows.length : "형식 오류"})`);

    const parsed = rows
      .map((r) => {
        let date = "";
        let best = 0;
        for (const v of Object.values(r)) {
          const sv = String(v ?? "").trim();
          if (/^\d{4}[./-]\d{2}[./-]\d{2}$/.test(sv)) date = sv.replace(/[./]/g, "-");
          const n = Number(sv.replace(/,/g, ""));
          if (Number.isFinite(n) && n > best) best = n;
        }
        return { date, value: best };
      })
      .filter((r) => r.date && r.value > 1e11); // 신용잔고는 수십조 원 — 백억 미만이면 다른 컬럼을 잘못 읽은 것
    if (parsed.length < 21) throw new Error("유효 행 부족");

    parsed.sort((a, b) => a.date.localeCompare(b.date));
    const latest = parsed[parsed.length - 1];
    const past = parsed[parsed.length - 21]; // 20영업일 전
    const change20dPct = ((latest.value - past.value) / past.value) * 100;
    const trillion = latest.value / 1e12;

    const note =
      change20dPct >= 10
        ? `신용융자 잔고 ${trillion.toFixed(1)}조원 — 최근 20일 새 ${change20dPct.toFixed(0)}% 급증. 빚투가 몰린 상태라 급락 시 반대매매 연쇄로 하락이 증폭될 수 있음`
        : change20dPct <= -10
          ? `신용융자 잔고 ${trillion.toFixed(1)}조원 — 최근 20일 새 ${Math.abs(change20dPct).toFixed(0)}% 감소. 강제청산 물량이 상당 부분 소진된 상태`
          : `신용융자 잔고 ${trillion.toFixed(1)}조원 (20일 전 대비 ${change20dPct >= 0 ? "+" : ""}${change20dPct.toFixed(1)}%)`;

    const data: CreditBalanceTrend = { latestDate: latest.date, latestTrillionKrw: trillion, change20dPct, note };
    cache = { data, expiresAt: now + TTL_OK_MS };
    return data;
  } catch (e) {
    console.warn("KOFIA 신용잔고 조회 실패(신호 비활성으로 진행):", String(e).slice(0, 150));
    cache = { data: null, expiresAt: now + TTL_FAIL_MS };
    return null;
  }
}
