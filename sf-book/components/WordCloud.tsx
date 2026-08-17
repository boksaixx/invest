"use client";

import { useState } from "react";
import { words } from "@/content/people";

// 단어마다 크기를 조금씩 달리해 수료식 화이트보드처럼 보이게 한다.
const sizes = [
  "1.5rem", "1.15rem", "1.35rem", "1.7rem", "1.1rem", "1.3rem", "1.45rem",
  "1.2rem", "1.6rem", "1.25rem", "1.4rem", "1.1rem", "1.5rem", "1.3rem",
];

export default function WordCloud() {
  const [active, setActive] = useState<number | null>(null);
  const shown = active === null ? null : words[active];

  return (
    <>
      <div className="wordcloud">
        {words.map((w, i) => (
          <button
            key={w.word}
            className="wordchip"
            style={{ fontSize: sizes[i % sizes.length] }}
            data-on={active === i}
            onClick={() => setActive(active === i ? null : i)}
            aria-pressed={active === i}
          >
            {w.word}
          </button>
        ))}
      </div>

      <div className="word-detail" aria-live="polite">
        {shown ? (
          <>
            <p className="ko">{shown.ko}</p>
            <p className="w serif">{shown.word}</p>
            <p className="gl">{shown.gloss}</p>
          </>
        ) : (
          <p className="dim">단어를 누르면 그 주의 어느 장면이었는지 나옵니다.</p>
        )}
      </div>
    </>
  );
}
