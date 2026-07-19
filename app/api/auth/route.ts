// 로그인/로그아웃. 정식 계정 시스템이 아니라 단일 비밀번호 게이트다.
import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, computeAuthToken } from "@/lib/authToken";

export async function POST(req: Request) {
  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) {
    return NextResponse.json({ error: "서버에 APP_PASSWORD가 설정되어 있지 않습니다." }, { status: 500 });
  }
  const body = (await req.json().catch(() => ({}))) as { password?: string };
  if (typeof body.password !== "string" || body.password !== appPassword) {
    return NextResponse.json({ error: "비밀번호가 올바르지 않습니다." }, { status: 401 });
  }
  const token = await computeAuthToken(appPassword);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 180, // 180일
    path: "/",
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE_NAME, "", { maxAge: 0, path: "/" });
  return res;
}
