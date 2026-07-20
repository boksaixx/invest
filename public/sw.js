// 최소 서비스워커 — 안드로이드 크롬의 "설치" 배너가 뜨려면 서비스워커 등록이 필요하다.
// 시세/조언 API는 절대 캐시하지 않는다(실거래 앱이라 오래된 데이터를 최신인 것처럼
// 보여주는 것이 가장 위험). 앱 셸(정적 리소스)만 네트워크 우선으로 캐시해 오프라인
// 진입 시 완전 백지 화면 대신 최소한의 셸이라도 뜨게 한다.
const CACHE_NAME = "invest-app-shell-v1";
const APP_SHELL = ["/", "/login"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // API 요청(시세/조언/뉴스 등 실시간성이 생명인 데이터)은 캐시하지 않고 항상 네트워크로만 처리
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(event.request, resClone))
          .catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))),
  );
});
