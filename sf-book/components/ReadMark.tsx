"use client";

import { useReadProgress } from "@/lib/progress";

export default function ReadMark({ slug }: { slug: string }) {
  const { has, toggle, ready } = useReadProgress();
  const done = has(slug);

  return (
    <div className="readmark" data-done={done}>
      <div>
        <div style={{ fontWeight: 600 }}>
          {done ? "이 장을 다 읽었습니다" : "여기까지 읽으셨나요?"}
        </div>
        <div className="dim" style={{ fontSize: ".85rem", marginTop: ".25rem" }}>
          차례에서 진도로 표시됩니다. 이 기기에만 저장돼요.
        </div>
      </div>
      <button
        className={done ? "btn btn-quiet" : "btn btn-primary"}
        onClick={() => toggle(slug)}
        disabled={!ready}
      >
        {done ? "표시 지우기" : "다 읽었어요"}
      </button>
    </div>
  );
}
