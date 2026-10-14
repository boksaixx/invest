import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "내 주식 비서",
  description: "삼성전자·SK하이닉스 2종목 — 지금 사야 할지, 기다릴지, 팔지 한 줄로",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "내 주식 비서",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#f2f4f6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        {/* 토스와 같은 계열의 한글 글꼴(Pretendard). 못 불러오면 기기 기본 글꼴로 */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body>
        {children}
        {/* 안드로이드 크롬의 "앱 설치" 배너가 뜨려면 서비스워커 등록이 필요하다.
            설치되면 별도 저장공간(WebAPK)이 생겨 일반 브라우저 탭보다 데이터가 안정적으로 유지된다. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); }); }`,
          }}
        />
      </body>
    </html>
  );
}
