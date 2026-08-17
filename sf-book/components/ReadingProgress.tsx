"use client";

import { useEffect, useState } from "react";

/** 문서를 얼마나 내려왔는지 보여주는 상단 막대. 챕터 본문에서만 쓴다. */
export default function ReadingProgress() {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement;
      const scrollable = h.scrollHeight - h.clientHeight;
      setPct(scrollable > 0 ? Math.min(100, (h.scrollTop / scrollable) * 100) : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className="progress-rail" aria-hidden="true">
      <div className="progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}
