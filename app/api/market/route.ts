// 실시간 시세 + 매크로 지수 조회
import { NextResponse } from "next/server";
import { getMacroSnapshot, getStockQuote } from "@/lib/market";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const [samsung, hynix, macro] = await Promise.all([
      getStockQuote("005930"),
      getStockQuote("000660"),
      getMacroSnapshot(),
    ]);
    return NextResponse.json({
      quotes: { "005930": samsung, "000660": hynix },
      macro,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
