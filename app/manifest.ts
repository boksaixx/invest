import type { MetadataRoute } from "next";

// 안드로이드 크롬에서 "설치" 배너/메뉴가 뜨려면 manifest + 아이콘 + 서비스워커가 필요하다.
// 설치되면 별도의 독립 저장공간(WebAPK)을 갖게 되어, 일반 브라우저 탭보다 데이터가
// 훨씬 안정적으로 유지된다(브라우저의 "인터넷 사용기록 삭제" 등에 영향을 덜 받음).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "내 주식 비서",
    short_name: "주식비서",
    description: "삼성전자·SK하이닉스 2종목 — 지금 사야 할지, 기다릴지, 팔지 한 줄로",
    start_url: "/",
    display: "standalone",
    background_color: "#f2f4f6",
    theme_color: "#f2f4f6",
    orientation: "portrait",
    icons: [
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
