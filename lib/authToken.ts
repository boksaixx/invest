// 비밀번호를 쿠키에 평문으로 저장하지 않기 위한 해시 토큰 생성.
// 미들웨어(Edge 런타임)와 로그인 API(Node 런타임) 양쪽에서 동일 로직을 써야 하므로
// 두 런타임 모두에 전역으로 존재하는 Web Crypto(crypto.subtle)만 사용한다.
export async function computeAuthToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`semi-trader-auth-v1:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const AUTH_COOKIE_NAME = "auth";
