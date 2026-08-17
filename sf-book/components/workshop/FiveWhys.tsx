"use client";

import { useState } from "react";

const LEVELS = 5;

const READINGS = [
  "아직 표면입니다. 첫 번째 대답은 거의 항상 증상이에요.",
  "한 겹 내려왔습니다. 여기서 멈추면 증상에 대책을 세우게 됩니다.",
  "진짜 원인이 모습을 드러내기 시작하는 구간입니다.",
  "루이가 시연에서 도달한 깊이입니다. 처음의 문제와 얼마나 달라졌는지 보세요.",
  "다섯 번째. 여기서 나온 원인에 자원을 투입하세요.",
];

export default function FiveWhys() {
  const [problem, setProblem] = useState("");
  const [answers, setAnswers] = useState<string[]>(Array(LEVELS).fill(""));

  const depth = answers.filter((a) => a.trim()).length;

  const update = (i: number, v: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[i] = v;
      return next;
    });
  };

  const reset = () => {
    setProblem("");
    setAnswers(Array(LEVELS).fill(""));
  };

  return (
    <div className="tool" id="five-whys">
      <div className="tool-head">
        <div>
          <p className="eyebrow">TOOL 01</p>
          <h3>5 Why — 증상에서 원인까지</h3>
        </div>
        <span className="from">6장 · Day 2</span>
      </div>
      <p className="how">
        &ldquo;왜?&rdquo;를 다섯 번 반복해 표면의 증상에서 근본 원인으로 내려간다. 첫 번째
        대답은 거의 항상 증상이고, 진짜 원인은 서너 번째 &ldquo;왜?&rdquo;에서 모습을 드러낸다.
      </p>

      <div className="tool-body">
        <div style={{ marginBottom: "1.4rem" }}>
          <label className="field" htmlFor="fw-problem">
            지금 눈에 보이는 문제
          </label>
          <input
            id="fw-problem"
            type="text"
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            placeholder="예) 혼자 집안일을 하는데 기분이 가라앉는다"
          />
        </div>

        <div className="why-ladder">
          {answers.map((a, i) => (
            <div className="why-step" key={i}>
              <div className="lv">WHY {i + 1}</div>
              <textarea
                value={a}
                onChange={(e) => update(i, e.target.value)}
                placeholder={
                  i === 0
                    ? "왜 그런가요?"
                    : "왜 그런가요? — 앞의 대답에 다시 '왜'를 던지세요"
                }
                disabled={i > 0 && !answers[i - 1].trim()}
                style={{ opacity: i > 0 && !answers[i - 1].trim() ? 0.45 : 1 }}
              />
            </div>
          ))}
        </div>

        <div className="why-depth">
          {depth === 0 ? (
            <>첫 번째 &ldquo;왜?&rdquo;부터 적어 보세요.</>
          ) : (
            <>
              <strong>{depth}단계</strong> 내려왔습니다 — {READINGS[depth - 1]}
              {depth >= 3 && problem.trim() ? (
                <div style={{ marginTop: ".8rem" }}>
                  처음 적은 문제: <em>{problem}</em>
                  <br />
                  지금 도달한 원인: <em>{answers[depth - 1]}</em>
                </div>
              ) : null}
            </>
          )}
        </div>

        {depth > 0 || problem ? (
          <button className="btn btn-quiet btn-sm" style={{ marginTop: "1.2rem" }} onClick={reset}>
            비우기
          </button>
        ) : null}
      </div>
    </div>
  );
}
