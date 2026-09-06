// 최소 서비스워커 — 안드로이드 크롬의 "설치" 배너가 뜨려면 서비스워커 등록이 필요하다.
// 시세/조언 API는 절대 캐시하지 않는다(실거래 앱이라 오래된 데이터를 최신인 것처럼
// 보여주는 것이 가장 위험). 앱 셸(정적 리소스)만 네트워크 우선으로 캐시해 오프라인
// 진입 시 완전 백지 화면 대신 최소한의 셸이라도 뜨게 한다.
//
// 캐시 이름은 배포마다 올린다(activate에서 옛 캐시를 지우므로) — 안 올리면 이전 배포의 청크가
// 영원히 쌓인다. 2026-09-06: v2 (실패·리다이렉트 응답을 캐시하던 문제 수정).
const CACHE_NAME = "invest-app-shell-v2";
// 로그인 전 "/"는 /login으로 리다이렉트되는데, 리다이렉트 응답은 내비게이션 캐시로 못 쓴다(크롬이 거부).
// 그래서 셸 사전 캐시는 /login만 한다. "/"는 로그인 후 첫 방문 때 fetch 핸들러가 정상 응답을 캐시한다.
const APP_SHELL = ["/login"];

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
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // 정상(200) + 리다이렉트 아님만 캐시한다. 4xx/5xx·리다이렉트를 캐시하면 오프라인에서
        // 오류 페이지나 로그인 리다이렉트가 "앱 셸"로 재생된다.
        if (res.ok && !res.redirected && res.type === "basic") {
          const resClone = res.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, resClone))
            .catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("/login") : undefined)),
      ),
  );
});
