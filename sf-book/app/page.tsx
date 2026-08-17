import Link from "next/link";
import Fog from "@/components/Fog";
import GoldenGate from "@/components/GoldenGate";
import Reveal from "@/components/Reveal";
import {
  book,
  byTheNumbers,
  executiveSummary,
  fiveLines,
  foreword,
  prologue,
  twoKeys,
} from "@/content/front";
import { days } from "@/content/journey";

function Telescope() {
  return (
    <svg className="glyph" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 30l24-12 8 6-24 12z" strokeLinejoin="round" />
      <path d="M30 18l4-8 8 4-4 8" strokeLinejoin="round" />
      <path d="M16 34v8M24 38v6" strokeLinecap="round" />
    </svg>
  );
}

function Compass() {
  return (
    <svg className="glyph" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="24" cy="24" r="18" />
      <path d="M31 17l-4 10-10 4 4-10z" strokeLinejoin="round" />
      <circle cx="24" cy="24" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function Home() {
  return (
    <>
      {/* ---------- 표지 ---------- */}
      <header className="hero">
        <Fog />
        <div className="hero-moon" aria-hidden="true" />
        <div className="wrap hero-content">
          <p className="hero-kicker">{book.series}</p>
          <h1>
            문제를 다시
            <br />
            정의하는 법
          </h1>
          <p className="hero-sub">{book.subtitle} — {book.dek}</p>
          <div className="hero-meta">
            <span>{book.period}</span>
            <span className="hide-sm">{book.places}</span>
            <span>{book.keywords.join(" · ")}</span>
          </div>
          <div className="hero-cta">
            <Link href="/book" className="btn btn-primary">
              책 펼치기 →
            </Link>
            <Link href="/journey" className="btn btn-ghost">
              8일의 여정 보기
            </Link>
          </div>
        </div>
        <GoldenGate className="hero-gate" />
        <div className="scroll-hint" aria-hidden="true">
          <i />
          SCROLL
        </div>
      </header>

      {/* ---------- 여는 글 ---------- */}
      <section className="band">
        <div className="wrap-narrow stack" style={{ ["--gap" as string]: "1.5rem" }}>
          <Reveal>
            <p className="eyebrow">{foreword.eyebrow}</p>
            <h2 className="serif" style={{ marginTop: ".9rem" }}>
              {foreword.title}
            </h2>
          </Reveal>
          {foreword.paragraphs.map((p, i) => (
            <Reveal key={i} delay={i * 70}>
              <p className="lede">{p}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- 프롤로그 ---------- */}
      <section className="band band-line">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">{prologue.eyebrow}</p>
              <h2 className="serif">{prologue.title}</h2>
              <p className="lede">{prologue.dek}</p>
            </div>
          </Reveal>

          <div className="grid grid-2" style={{ gap: "2.5rem", alignItems: "start" }}>
            <Reveal>
              <div className="stack">
                {prologue.paragraphs.map((p, i) => (
                  <p key={i} style={{ color: "var(--fog-200)", lineHeight: 1.95 }}>
                    {p}
                  </p>
                ))}
              </div>
            </Reveal>
            <Reveal delay={100}>
              <div className="stack">
                <blockquote style={{ margin: 0 }}>
                  <q>{prologue.pullQuote}</q>
                </blockquote>
                <div className="facts">
                  <h4>이 책을 읽는 법</h4>
                  <dl>
                    {prologue.howToRead.map((r) => (
                      <div className="row" key={r.n}>
                        <dt>{r.n}</dt>
                        <dd>{r.text}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <figure className="photo">
                  <span className="tag">PHOTO</span>
                  <figcaption>{prologue.photo}</figcaption>
                </figure>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ---------- 두 열쇠말 ---------- */}
      <section className="band band-line">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">{twoKeys.eyebrow}</p>
              <h2 className="serif">{twoKeys.title}</h2>
              <p className="lede">{twoKeys.dek}</p>
            </div>
          </Reveal>
          <div className="grid grid-2">
            {twoKeys.keys.map((k, i) => (
              <Reveal key={k.en} delay={i * 110}>
                <article className="keycard">
                  {k.icon === "telescope" ? <Telescope /> : <Compass />}
                  <div>
                    <p className="eyebrow">
                      {k.ko} · {k.en}
                    </p>
                    <h3 className="serif" style={{ marginTop: ".5rem" }}>
                      {k.name}
                    </h3>
                    <p className="dim" style={{ marginTop: ".35rem", fontSize: ".9rem" }}>
                      {k.role}
                    </p>
                  </div>
                  <p style={{ color: "var(--ink-soft)", flex: 1 }}>{k.body}</p>
                  <Link href={k.to} className="btn btn-quiet btn-sm" style={{ alignSelf: "flex-start" }}>
                    {k.where} →
                  </Link>
                </article>
              </Reveal>
            ))}
          </div>
          <Reveal>
            <p className="lede center" style={{ marginTop: "2.5rem", maxWidth: "44rem", marginInline: "auto" }}>
              {twoKeys.closing}
            </p>
          </Reveal>
        </div>
      </section>

      {/* ---------- 숫자로 보는 8일 ---------- */}
      <section className="band band-line">
        <div className="wrap">
          <Reveal>
            <p className="eyebrow center">BY THE NUMBERS</p>
            <h2 className="serif center" style={{ marginTop: ".8rem", marginBottom: "3rem" }}>
              숫자로 보는 8일
            </h2>
          </Reveal>
          <div className="grid grid-4">
            {byTheNumbers.map((s, i) => (
              <Reveal key={s.label} delay={i * 80}>
                <div className="stat center">
                  <div className="n serif">{s.n}</div>
                  <div className="label">{s.label}</div>
                  <div className="sub">{s.sub}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- 여정 미리보기 ---------- */}
      <section className="band band-line">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">ITINERARY</p>
              <h2 className="serif">여정 한눈에 보기</h2>
              <p className="lede">
                2026년 6월 22일부터 26일까지. 인터뷰 하루, 수업 4일의 동선.
              </p>
            </div>
          </Reveal>
          <div className="grid grid-3">
            {days.map((d, i) => (
              <Reveal key={d.date} delay={i * 70}>
                <Link href={`/journey#${d.date.replace(".", "-")}`} className="card" style={{ display: "block", height: "100%" }}>
                  <div className="tl-date">
                    <span className="d">{d.date}</span>
                    <span className="dow">{d.dow}</span>
                  </div>
                  <h3 style={{ marginTop: ".8rem", fontSize: "1.08rem" }}>{d.title}</h3>
                  <p className="dim" style={{ marginTop: ".5rem", fontSize: ".86rem" }}>
                    {d.speaker}
                  </p>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- 먼저 읽는 한 페이지 ---------- */}
      <section className="band band-line">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">{executiveSummary.eyebrow}</p>
              <h2 className="serif">{executiveSummary.title}</h2>
              <p className="lede">{executiveSummary.dek}</p>
            </div>
          </Reveal>
          <div className="grid grid-3">
            {executiveSummary.decisions.map((d, i) => (
              <Reveal key={d.n} delay={i * 90}>
                <article className="card" style={{ height: "100%" }}>
                  <div className="decision">
                    <div className="num serif">{d.n}</div>
                    <div>
                      <p className="eyebrow eyebrow-fog">{d.kind}</p>
                      <h3 style={{ marginTop: ".6rem", fontSize: "1.06rem" }}>{d.title}</h3>
                      <p style={{ marginTop: ".7rem", color: "var(--ink-soft)", fontSize: ".93rem" }}>
                        {d.body}
                      </p>
                      <p className="dim" style={{ marginTop: ".8rem", fontSize: ".8rem" }}>
                        → {d.ref}
                      </p>
                    </div>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- 가장 비싼 문장 다섯 ---------- */}
      <section className="band band-line">
        <div className="wrap-narrow">
          <Reveal>
            <div className="section-head">
              <p className="eyebrow">{fiveLines.eyebrow}</p>
              <h2 className="serif">{fiveLines.title}</h2>
            </div>
          </Reveal>
          <div className="stack" style={{ ["--gap" as string]: "2rem" }}>
            {fiveLines.lines.map((l, i) => (
              <Reveal key={l.text} delay={i * 70}>
                <Link href={`/book/${l.slug}`} className="fiveline">
                  <q>{l.text}</q>
                  <span className="attrib">
                    {l.by} · {l.ref}
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
          <Reveal>
            <div className="center" style={{ marginTop: "4rem" }}>
              <Link href="/book" className="btn btn-primary">
                열두 장 전체 목차 →
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
