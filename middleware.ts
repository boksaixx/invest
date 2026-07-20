// 간단 비밀번호 게이트. 정식 계정 시스템은 아니며, 배포 주소를 아는 타인이
// 내 Claude/Gemini API 크레딧을 함부로 소모하지 못하게 막는 최소한의 방어선이다.
// APP_PASSWORD 환경변수를 따로 설정하지 않아도 기본 비밀번호(lib/authToken.ts)로 항상 켜져 있다.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, computeAuthToken, resolveAppPassword } from "@/lib/authToken";

// PWA 설치(매니페스트/아이콘/서비스워커)에 필요한 정적 리소스는 비밀번호 게이트 없이 항상
// 접근 가능해야 한다 — 브라우저가 설치 가능 여부를 검사할 때 로그인 상태가 아니므로,
// 여기가 막혀 있으면 "설치" 배너 자체가 뜨지 않는다. 민감 정보가 아니라 앱 브랜딩용 자산일 뿐이다.
const PUBLIC_PATHS = [
  "/login",
  "/api/auth",
  "/manifest.webmanifest",
  "/icon",
  "/icon-192",
  "/icon-512",
  "/apple-icon",
  "/sw.js",
];

export async function middleware(req: NextRequest) {
  const appPassword = resolveAppPassword();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  const expected = await computeAuthToken(appPassword);
  if (cookie === expected) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "비밀번호 인증이 필요합니다." }, { status: 401 });
  }
  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
