"use client";

import { useEffect, useRef, useState } from "react";

const DURATION = 120; // 책의 실험과 같은 2분

// "Yes, But" 모드에서 아이디어마다 먼저 튀어나오는 반박들.
const BUTS = [
  "모두 배고프지 않을 수도 있는데요.",
  "예산이 없어요.",
  "날씨가 나쁘면요?",
  "그건 작년에도 해봤잖아요.",
  "시간이 안 될 것 같은데요.",
  "채식하는 사람은 어떡하죠?",
  "윗분들이 싫어할 텐데요.",
];

const ANDS = [
  "좋아요, 그리고 다 같이 코스튬!",
  "좋아요, 그리고 영상 찍어 상영회까지!",
  "좋아요, 그리고 샴페인도!",
  "좋아요, 그리고 끝나고 삼겹살!",
  "좋아요, 그리고 초대장을 손으로 그려서!",
  "좋아요, 그리고 다음 주에 또 해요!",
];

type Entry = { id: number; text: string; echo: string };

export default function YesAnd() {
  const [mode, setMode] = useState<"and" | "but">("and");
  const [left, setLeft] = useState(DURATION);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          setRunning(false);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    const pool = mode === "and" ? ANDS : BUTS;
    setEntries((prev) => [
      ...prev,
      { id: nextId.current++, text, echo: pool[Math.floor(Math.random() * pool.length)] },
    ]);
    setDraft("");
    if (!running && left > 0) setRunning(true);
  };

  const restart = (m: "and" | "but") => {
    setMode(m);
    setEntries([]);
    setLeft(DURATION);
    setRunning(false);
    setDraft("");
  };

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  const done = left === 0;

  return (
    <div className="tool" id="yes-and">
      <div className="tool-head">
        <div>
          <p className="eyebrow">TOOL 03</p>
          <h3>&ldquo;Yes, And&rdquo; 2분 실험</h3>
        </div>
        <span className="from">7장 · Day 3</span>
      </div>
      <p className="how">
        같은 2분, 같은 사람들. 규칙 하나만 바꿨을 뿐인데 한쪽은 침묵했고 한쪽은 폭발했다. 팀에서
        생일이 가장 가까운 사람의 깜짝 파티를 기획해 보세요.
      </p>

      <div className="tool-body">
        <div className="timer">
          <div className="clock" data-warn={left <= 20 && left > 0}>
            {mm}:{ss}
          </div>
          <div className="mode-toggle" role="group" aria-label="브레인스토밍 규칙">
            <button data-on={mode === "and"} onClick={() => restart("and")}>
              Yes, And
            </button>
            <button data-on={mode === "but"} onClick={() => restart("but")}>
              Yes, But
            </button>
          </div>
          <div style={{ fontSize: ".9rem", color: "var(--ink-soft)" }}>
            아이디어 <strong style={{ color: "var(--moon)" }}>{entries.length}</strong>개
          </div>
        </div>

        <p
          style={{
            marginTop: "1rem",
            fontSize: ".9rem",
            color: mode === "and" ? "#7fd6a6" : "var(--gate-bright)",
          }}
        >
          {mode === "and"
            ? "규칙 — 무엇이 나와도 \"좋아요, 그리고\"로 받는다. 판단은 나중에."
            : "규칙 — 아이디어가 나오면 먼저 왜 안 되는지부터 말해야 한다."}
        </p>

        <div style={{ display: "flex", gap: ".6rem", marginTop: "1.3rem", flexWrap: "wrap" }}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder={done ? "2분이 끝났습니다" : "아이디어를 적고 Enter"}
            disabled={done}
            style={{ flex: "1 1 16rem" }}
          />
          <button className="btn btn-primary" onClick={add} disabled={done || !draft.trim()}>
            내기
          </button>
          {(entries.length > 0 || left < DURATION) && (
            <button className="btn btn-quiet" onClick={() => restart(mode)}>
              다시
            </button>
          )}
        </div>

        <ul className="idea-list">
          {entries.map((e) => (
            <li key={e.id}>
              <span>{e.text}</span>
              <span
                style={{
                  display: "block",
                  marginTop: ".3rem",
                  fontSize: ".84rem",
                  color: mode === "and" ? "#7fd6a6" : "var(--gate-bright)",
                }}
              >
                {mode === "and" ? "↑ " : "✕ "}
                {e.echo}
              </span>
            </li>
          ))}
        </ul>

        {done ? (
          <div className="why-depth" style={{ marginTop: "1.4rem" }}>
            2분 동안 <strong>{entries.length}개</strong>가 나왔습니다.{" "}
            {mode === "but"
              ? "이제 규칙을 Yes, And로 바꾸고 같은 2분을 다시 해보세요. 뇌에서 비판하는 부분과 새로 만드는 부분은 동시에 켜지지 않습니다."
              : "비판이 나쁜 게 아닙니다. 자리가 따로 있을 뿐 — 이제 아래 임팩트 매트릭스로 수렴할 차례입니다."}
          </div>
        ) : null}
      </div>
    </div>
  );
}
