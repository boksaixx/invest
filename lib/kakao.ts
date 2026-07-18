// 카카오톡 "나에게 보내기" (선택 기능)
// 필요 환경변수: KAKAO_REST_KEY, KAKAO_REFRESH_TOKEN (README의 카카오 연동 가이드 참고)
// 리프레시 토큰으로 액세스 토큰을 갱신한 뒤 메모 전송 API를 호출한다.

export async function sendKakaoMemo(text: string): Promise<boolean> {
  const restKey = process.env.KAKAO_REST_KEY;
  const refreshToken = process.env.KAKAO_REFRESH_TOKEN;
  if (!restKey || !refreshToken) return false;

  try {
    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: restKey,
        refresh_token: refreshToken,
      }),
    });
    if (!tokenRes.ok) {
      console.error("카카오 토큰 갱신 실패:", tokenRes.status, await tokenRes.text().catch(() => ""));
      return false;
    }
    const tokenJson = await tokenRes.json();
    const accessToken: string = tokenJson.access_token;

    const template = {
      object_type: "text",
      text: text.slice(0, 1900), // 카카오 텍스트 템플릿 제한 대비
      link: { web_url: process.env.APP_URL || "https://vercel.com", mobile_web_url: process.env.APP_URL || "https://vercel.com" },
      button_title: "대시보드 열기",
    };

    const sendRes = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ template_object: JSON.stringify(template) }),
    });
    if (!sendRes.ok) {
      console.error("카카오 메시지 전송 실패:", sendRes.status, await sendRes.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("카카오 전송 오류:", e);
    return false;
  }
}
