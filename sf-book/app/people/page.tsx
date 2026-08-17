import type { Metadata } from "next";
import Link from "next/link";
import Fog from "@/components/Fog";
import GoldenGate from "@/components/GoldenGate";
import WordCloud from "@/components/WordCloud";
import { closingQuote, words } from "@/content/people";

export const metadata: Metadata = { title: "열넷" };

export default function People() {
  return (
    <>
      <section className="band">
        <Fog />
        <div className="wrap-narrow center" style={{ position: "relative", zIndex: 1 }}>
          <p className="eyebrow">GRADUATION · 2026.06.26</p>
          <h1 className="serif" style={{ marginTop: "1rem" }}>
            이번 주를 한 단어로
          </h1>
          <p className="lede" style={{ marginTop: "1.3rem" }}>
            마지막 날 수료식에서 각자 이번 주를 한 단어로 표현했다. 책에 남은 단어는 정확히
            열넷 — 함께 간 사람의 수와 같다.
          </p>
        </div>

        <div className="wrap" style={{ marginTop: "3.5rem", position: "relative", zIndex: 1 }}>
          <WordCloud />
        </div>
      </section>

      <section className="band band-line">
        <div className="wrap">
          <div className="section-head">
            <p className="eyebrow">FOURTEEN WORDS</p>
            <h2 className="serif">열넷, 그리고 그 자리</h2>
            <p className="lede">
              같은 8일을 지나왔는데 남은 단어가 저마다 달랐다. 관점의 차이 자체가 이 기록의
              일부다.
            </p>
          </div>
          <div className="grid grid-3">
            {words.map((w) => (
              <article className="card" key={w.word}>
                <p className="eyebrow">{w.ko}</p>
                <h3 className="serif" style={{ marginTop: ".6rem", fontSize: "1.5rem" }}>
                  {w.word}
                </h3>
                <p style={{ marginTop: ".8rem", color: "var(--ink-soft)", fontSize: ".93rem" }}>
                  {w.gloss}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="band band-line" style={{ overflow: "hidden", position: "relative" }}>
        <div className="wrap-narrow center" style={{ position: "relative", zIndex: 2 }}>
          <blockquote style={{ margin: 0 }}>
            <q>{closingQuote.text}</q>
            <span className="by">{closingQuote.by}</span>
          </blockquote>
          <div style={{ marginTop: "3rem", display: "flex", gap: ".7rem", justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/book" className="btn btn-primary">
              다시 책으로 →
            </Link>
            <Link href="/workshop" className="btn btn-quiet">
              워크숍 도구
            </Link>
          </div>
        </div>
        {/* 마지막 페이지의 마침표처럼 아주 흐리게 깔아 둔다 */}
        <GoldenGate className="page-gate" />
      </section>
    </>
  );
}
