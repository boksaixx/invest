// 실시간 시세 + 매크로 지수 조회
import { NextResponse } from "next/server";
import { getMacroSnapshot, getStockQuote } from "@/lib/market";
import { TICKER_LIST } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const [quotes, macro] = await Promise.all([
      Promise.all(TICKER_LIST.map((t) => getStockQuote(t))),
      getMacroSnapshot(),
    ]);
    return NextResponse.json({
      quotes: Object.fromEntries(TICKER_LIST.map((t, i) => [t, quotes[i]])),
      macro,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
