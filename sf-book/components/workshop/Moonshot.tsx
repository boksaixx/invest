"use client";

import { useState } from "react";

const PROMPTS = [
  "이 문제가 완전히 사라진다면, 세상은 어떤 모습인가?",
  "개선하려는 그 행위 자체를 없앨 수는 없는가? (\"운전을 더 안전하게\" → \"운전자를 없애자\")",
  "우리가 파는 것이 물건이 아니라 서비스라면?",
  "이 목표가 목적지가 아니라 디딤돌이라면, 그다음은 무엇인가?",
  "가장 어려운 난제를 1단계에 놓는다면 무엇부터 증명해야 하는가? (Monkey First)",
];

const PRINCIPLES = [
  "10x over 10%",
  "거대한 문제에 집중",
  "실패를 껴안기",
  "가장 어려운 것 먼저",
  "다양한 관점",
  "관점 전환",
  "현실에서 테스트",
  "긴박감 만들기",
];

export default function Moonshot() {
  const [ten, setTen] = useState("");
  const [x, setX] = useState("");
  const [steps, setSteps] = useState(["", "", ""]);
  const [openPrompt, setOpenPrompt] = useState<number | null>(null);

  const setStep = (i: number, v: string) =>
    setSteps((p) => {
      const n = [...p];
      n[i] = v;
      return n;
    });

  return (
    <div className="tool" id="moonshot">
      <div className="tool-head">
        <div>
          <p className="eyebrow">TOOL 05</p>
          <h3>10x 리프레이머 — 문제를 다시 적기</h3>
        </div>
        <span className="from">5장 · Day 1</span>
      </div>
      <p className="how">
        문샷은 번뜩이는 광기가 아니라, 원하는 미래에서 거꾸로 &ldquo;가장 논리적인 다음
        단계&rdquo;를 계산해 내려오는 과정이다. 10%안 옆에 10배안을 나란히 놓는 것만으로 논의의
        차원이 바뀐다.
      </p>

      <div className="tool-body">
        <div className="reframe">
          <div className="col" data-kind="ten-pct">
            <div className="cap">10% — 지금의 목표</div>
            <textarea
              value={ten}
              onChange={(e) => setTen(e.target.value)}
              placeholder="예) 상담 응대 시간을 10% 줄인다"
              style={{ marginTop: ".7rem" }}
            />
            {ten.trim() ? <p className="txt serif">{ten}</p> : null}
          </div>
          <div className="col" data-kind="ten">
            <div className="cap">10x — 문제가 사라진 목표</div>
            <textarea
              value={x}
              onChange={(e) => setX(e.target.value)}
              placeholder="예) 문의할 일 자체가 생기지 않게 한다"
              style={{ marginTop: ".7rem" }}
            />
            {x.trim() ? <p className="txt serif">{x}</p> : null}
          </div>
        </div>

        <div className="prompts">
          <p className="field" style={{ marginBottom: 0 }}>
            막히면 — 문샷 팩토리가 던지는 질문들
          </p>
          {PROMPTS.map((p, i) => (
            <button
              key={p}
              className="prompt"
              onClick={() => setOpenPrompt(openPrompt === i ? null : i)}
              data-on={openPrompt === i}
              style={openPrompt === i ? { borderColor: "var(--gate)", color: "var(--ink)" } : undefined}
            >
              {p}
            </button>
          ))}
        </div>

        <div style={{ marginTop: "2.2rem" }}>
          <p className="field">
            NASA의 세 계단 — 단계마다 &lsquo;검증할 것 딱 하나&rsquo;
          </p>
          <div className="steps">
            {["MERCURY", "GEMINI", "APOLLO"].map((name, i) => (
              <div className="step" key={name}>
                <div className="n">{name}</div>
                <input
                  type="text"
                  value={steps[i]}
                  onChange={(e) => setStep(i, e.target.value)}
                  placeholder={
                    i === 0
                      ? "가장 어려운 난제를 여기에 (Monkey First)"
                      : `${i + 1}단계에서 증명할 것 하나`
                  }
                />
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: "2rem" }}>
          <p className="field">X THE MOONSHOT FACTORY — 8가지 원칙</p>
          <div className="chips">
            {PRINCIPLES.map((p) => (
              <span className="chip" key={p}>
                {p}
              </span>
            ))}
          </div>
        </div>

        {ten.trim() && x.trim() ? (
          <div className="why-depth" style={{ marginTop: "1.6rem" }}>
            두 문장을 나란히 놓았습니다. 이제 물어볼 차례입니다 —{" "}
            <strong>어느 쪽이 경쟁자 전부와 싸우는 길인가?</strong> 10% 개선은 기존 방식 안에서
            모두와 싸우는 일이지만, 10배 목표는 기존 방식을 버리게 만들어 경쟁 없는 새 길을 연다.
          </div>
        ) : null}
      </div>
    </div>
  );
}
