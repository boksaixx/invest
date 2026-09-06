import type { MetadataRoute } from "next";

// 안드로이드 크롬에서 "설치" 배너/메뉴가 뜨려면 manifest + 아이콘 + 서비스워커가 필요하다.
// 설치되면 별도의 독립 저장공간(WebAPK)을 갖게 되어, 일반 브라우저 탭보다 데이터가
// 훨씬 안정적으로 유지된다(브라우저의 "인터넷 사용기록 삭제" 등에 영향을 덜 받음).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "내 주식 비서",
    short_name: "주식비서",
    description: "국내 10종목(반도체 5 + 방산·자동차·금융·바이오·통신) 단타 어드바이스 AI 에이전트",
    start_url: "/",
    display: "standalone",
    background_color: "#f2f4f6",
    theme_color: "#3182f6",
    orientation: "portrait",
    icons: [
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
