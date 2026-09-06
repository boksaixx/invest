import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "내 주식 비서",
  description: "국내 10종목(반도체 5 + 방산·자동차·금융·바이오·통신) 단타 어드바이스 AI 에이전트",
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
  themeColor: "#3182f6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
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
