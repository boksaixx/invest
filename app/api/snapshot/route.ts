// GitHub Actions 자동 수집 데이터(15분 간격) 조회
import { NextResponse } from "next/server";
import { fetchLatestSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await fetchLatestSnapshot();
  // 첫 화면 로드마다 어차피 호출되는 엔드포인트라, 여기에 "기본 비밀번호로 열려 있는지"를 함께 실어
  // 별도 요청 없이 경고를 띄운다. 비밀번호 값 자체는 절대 내보내지 않고 설정 여부만 알린다.
  return NextResponse.json({ snapshot, defaultPassword: !process.env.APP_PASSWORD });
}
