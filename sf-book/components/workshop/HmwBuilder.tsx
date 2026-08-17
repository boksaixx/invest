"use client";

import { useState } from "react";

/**
 * 책의 판정 기준(너무 좁음 / 적절함 / 너무 넓음)을 아주 단순한 신호로 흉내 낸 것.
 * 정답기가 아니라 "답이 이미 박혀 있지 않은가"를 되묻게 하는 장치다.
 */
const SOLUTION_WORDS = [
  "앱", "어플", "플랫폼", "시스템", "서비스", "버튼", "기계", "세탁기", "챗봇",
  "웹사이트", "사이트", "프로그램", "솔루션", "AI를 도입", "도입해", "만들어서",
];

function judge(who: string, change: string) {
  const w = who.trim();
  const c = change.trim();
  if (!w || !c) return null;

  const named = SOLUTION_WORDS.find((s) => c.includes(s));
  if (named) {
    return {
      v: "narrow" as const,
      label: "너무 좁을 수 있습니다",
      why: `'${named}'라는 해결책이 이미 문장 안에 박혀 있습니다. 답을 빼고 '어떤 상태가 되기를 바라는가'만 남겨 보세요.`,
    };
  }
  if (c.length <= 5 || w.length <= 2) {
    return {
      v: "wide" as const,
      label: "너무 넓을 수 있습니다",
      why: "어디서부터 손댈지 알기 어렵습니다. 누가, 어떤 상황에서인지를 한 겹 더 좁혀 보세요.",
    };
  }
  return {
    v: "good" as const,
    label: "적절해 보입니다",
    why: "방향은 주되 답은 열려 있습니다. 이 문장으로 발산을 시작해도 좋습니다.",
  };
}

const EXAMPLES = [
  { who: "혼자 가사를 하는 사람", change: "연결된 느낌을 받을 수" },
  { who: "처음 혼자가 된 신입생", change: "부담 없이 새 친구를 만들 수" },
  { who: "분리수거를 망설이는 학생", change: "틀려도 괜찮다고 믿을 수" },
];

export default function HmwBuilder() {
  const [who, setWho] = useState("");
  const [change, setChange] = useState("");

  const verdict = judge(who, change);

  return (
    <div className="tool" id="hmw">
      <div className="tool-head">
        <div>
          <p className="eyebrow">TOOL 02</p>
          <h3>HMW — 풀 수 있는 질문으로</h3>
        </div>
        <span className="from">6장 · Day 2</span>
      </div>
      <p className="how">
        문제를 절망(&ldquo;이건 불가능해&rdquo;)이 아니라 초대(&ldquo;함께 방법을 찾아보자&rdquo;)의
        문장으로 바꾸는 장치. 카메라 조리개처럼 질문의 넓이를 조절하는 것이 핵심이다.
      </p>

      <div className="tool-body">
        <div className="grid grid-2">
          <div>
            <label className="field" htmlFor="hmw-who">
              누가 / 어떤 상황에서
            </label>
            <input
              id="hmw-who"
              type="text"
              value={who}
              onChange={(e) => setWho(e.target.value)}
              placeholder="혼자 가사를 하는 사람"
            />
          </div>
          <div>
            <label className="field" htmlFor="hmw-change">
              어떤 상태가 되기를 바라는가
            </label>
            <input
              id="hmw-change"
              type="text"
              value={change}
              onChange={(e) => setChange(e.target.value)}
              placeholder="연결된 느낌을 받을 수"
            />
          </div>
        </div>

        <div className="hmw-out">
          <p className="sentence">
            우리가 어떻게 하면 <em>{who.trim() || "○○○"}</em>가/이{" "}
            <em>{change.trim() || "△△△"}</em> 있을까?
          </p>
          {verdict ? (
            <>
              <span className="verdict" data-v={verdict.v}>
                {verdict.label}
              </span>
              <p style={{ marginTop: ".8rem", fontSize: ".9rem", color: "var(--ink-soft)" }}>
                {verdict.why}
              </p>
            </>
          ) : (
            <p style={{ marginTop: ".8rem", fontSize: ".88rem", color: "var(--ink-faint)" }}>
              두 칸을 채우면 넓이를 함께 살펴봅니다.
            </p>
          )}
        </div>

        <div className="prompts">
          <p className="field" style={{ marginBottom: 0 }}>
            책에서 가져온 예시로 채워보기
          </p>
          {EXAMPLES.map((e) => (
            <button
              key={e.who}
              className="prompt"
              onClick={() => {
                setWho(e.who);
                setChange(e.change);
              }}
            >
              {e.who} → {e.change} 있을까?
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
