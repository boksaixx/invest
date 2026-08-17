"use client";

import { useRef, useState } from "react";

type Zone = "staging" | "do" | "challenge" | "skip" | "never";
type Note = { id: number; text: string; zone: Zone };

const QUADS: { key: Zone; title: string; sub: string }[] = [
  { key: "do", title: "여기부터 실행", sub: "높은 임팩트 · 실행 쉬움" },
  { key: "challenge", title: "도전 과제로 관리", sub: "높은 임팩트 · 실행 어려움" },
  { key: "skip", title: "해도 의미 없음", sub: "낮은 임팩트 · 실행 쉬움" },
  { key: "never", title: "하지 말 것", sub: "낮은 임팩트 · 실행 어려움" },
];

const SEED = [
  "BTS를 초청한다",
  "지역 공연자 정기 공연",
  "학식당에 합석 테이블",
  "신입생 러닝 크루",
];

export default function ImpactMatrix() {
  const [notes, setNotes] = useState<Note[]>(
    SEED.map((text, i) => ({ id: i + 1, text, zone: "staging" }))
  );
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [over, setOver] = useState<Zone | null>(null);
  const nextId = useRef(SEED.length + 1);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setNotes((p) => [...p, { id: nextId.current++, text, zone: "staging" }]);
    setDraft("");
  };

  const move = (id: number, zone: Zone) => {
    setNotes((p) => p.map((n) => (n.id === id ? { ...n, zone } : n)));
    setPicked(null);
  };

  const remove = (id: number) => {
    setNotes((p) => p.filter((n) => n.id !== id));
    setPicked((c) => (c === id ? null : c));
  };

  const inZone = (z: Zone) => notes.filter((n) => n.zone === z);

  const dropProps = (zone: Zone) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(zone);
    },
    onDragLeave: () => setOver((c) => (c === zone ? null : c)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(null);
      const id = Number(e.dataTransfer.getData("text/plain"));
      if (id) move(id, zone);
    },
    onClick: () => {
      if (picked !== null) move(picked, zone);
    },
    "data-over": over === zone,
  });

  const NoteChip = ({ n }: { n: Note }) => (
    <div
      className="note"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(n.id));
        setPicked(n.id);
      }}
      onDragEnd={() => setPicked(null)}
      data-dragging={picked === n.id}
      onClick={(e) => {
        e.stopPropagation();
        setPicked(picked === n.id ? null : n.id);
      }}
      style={
        picked === n.id
          ? { outline: "2px solid var(--gate)", outlineOffset: "2px" }
          : undefined
      }
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setPicked(picked === n.id ? null : n.id);
        }
      }}
    >
      <span>{n.text}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          remove(n.id);
        }}
        aria-label={`${n.text} 지우기`}
      >
        ×
      </button>
    </div>
  );

  return (
    <div className="tool" id="matrix">
      <div className="tool-head">
        <div>
          <p className="eyebrow">TOOL 04</p>
          <h3>임팩트 × 실행 가능성 매트릭스</h3>
        </div>
        <span className="from">7장 · Day 3</span>
      </div>
      <p className="how">
        발산이 끝나면 수렴할 차례. &ldquo;학생 외로움을 풀겠다고 BTS를 초청하자&rdquo; — 임팩트
        최상, 실행 최악. 원칙은 하나다. &lsquo;고임팩트 · 실행 쉬움&rsquo; 칸부터 저비용
        시제품으로 검증한다.
      </p>

      <div className="tool-body">
        <div style={{ display: "flex", gap: ".6rem", flexWrap: "wrap" }}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder="아이디어를 적고 Enter"
            style={{ flex: "1 1 16rem" }}
          />
          <button className="btn btn-primary" onClick={add} disabled={!draft.trim()}>
            붙이기
          </button>
        </div>

        <p style={{ marginTop: "1rem", fontSize: ".85rem", color: "var(--ink-faint)" }}>
          포스트잇을 끌어다 놓거나, 눌러서 고른 뒤 칸을 누르세요.
          {picked !== null ? (
            <strong style={{ color: "var(--gate-bright)" }}> — 이제 칸을 누르세요</strong>
          ) : null}
        </p>

        <div className="staging" style={{ marginTop: ".9rem" }} {...dropProps("staging")}>
          <div className="qh" style={{ fontFamily: "var(--mono)", fontSize: ".64rem", letterSpacing: ".14em", color: "var(--ink-faint)" }}>
            아직 분류 안 함 · {inZone("staging").length}
          </div>
          <div className="notes">
            {inZone("staging").map((n) => (
              <NoteChip n={n} key={n.id} />
            ))}
          </div>
        </div>

        <div className="matrix">
          {QUADS.map((q) => (
            <div className="quad" data-key={q.key} key={q.key} {...dropProps(q.key)}>
              <div className="qh">{q.title}</div>
              <div className="qs">{q.sub}</div>
              <div className="notes">
                {inZone(q.key).map((n) => (
                  <NoteChip n={n} key={n.id} />
                ))}
              </div>
            </div>
          ))}
        </div>

        {inZone("do").length > 0 ? (
          <div className="why-depth" style={{ marginTop: "1.3rem" }}>
            &lsquo;여기부터 실행&rsquo;에 <strong>{inZone("do").length}개</strong>가 있습니다.
            회의를 끝내기 전에 그중 하나를 골라 <strong>시제품 담당자</strong>까지 정하세요 —
            그게 책이 말한 회의의 마무리입니다.
          </div>
        ) : null}
      </div>
    </div>
  );
}
