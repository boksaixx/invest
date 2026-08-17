"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "sfbook.read.v1";

function load(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function save(slugs: string[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(slugs));
  } catch {
    /* 사파리 프라이빗 모드 등에서 저장이 막혀도 앱은 계속 동작해야 한다 */
  }
  window.dispatchEvent(new CustomEvent("sfbook:read"));
}

/**
 * 읽은 장 목록. 서버 렌더 결과와 어긋나지 않도록 첫 렌더는 항상 빈 배열로 두고,
 * 마운트 뒤에 localStorage 값을 채운다.
 */
export function useReadProgress() {
  const [read, setRead] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setRead(load());
    sync();
    setReady(true);
    window.addEventListener("sfbook:read", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("sfbook:read", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const toggle = useCallback((slug: string) => {
    const next = load();
    const i = next.indexOf(slug);
    if (i >= 0) next.splice(i, 1);
    else next.push(slug);
    save(next);
    setRead(next);
  }, []);

  const reset = useCallback(() => {
    save([]);
    setRead([]);
  }, []);

  return { read, ready, toggle, reset, has: (s: string) => read.includes(s) };
}
