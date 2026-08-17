import type { Metadata } from "next";
import Link from "next/link";
import Fog from "@/components/Fog";
import Reveal from "@/components/Reveal";
import { days } from "@/content/journey";
import { byTheNumbers } from "@/content/front";

export const metadata: Metadata = { title: "8일의 여정" };

export default function Journey() {
  return (
    <>
      <section className="band">
        <Fog />
        <div className="wrap" style={{ position: "relative", zIndex: 1 }}>
          <div className="section-head">
            <p className="eyebrow">ITINERARY · 2026.06.22 — 06.26</p>
            <h1 className="serif">8일의 여정</h1>
            <p className="lede">
              SFO에 내려 팔로알토까지. 인터뷰 하루와 수업 나흘, 그리고 그 사이에 무너진 가설들.
              날짜를 누르면 그날의 장으로 갑니다.
            </p>
          </div>

          <div className="grid grid-4" style={{ marginBottom: "4rem" }}>
            {byTheNumbers.map((s) => (
              <div className="stat" key={s.label}>
                <div className="n serif">{s.n}</div>
                <div className="label">{s.label}</div>
                <div className="sub">{s.sub}</div>
              </div>
            ))}
          </div>

          <div className="timeline">
            {days.map((d, i) => (
              <Reveal key={d.date} delay={i * 60}>
                <div className="tl-item" id={d.date.replace(".", "-")}>
                  <div className="tl-date">
                    <span className="d">{d.date}</span>
                    <span className="dow">{d.dow}</span>
                    <span className="lb">{d.label}</span>
                  </div>
                  <div className="tl-card">
                    <p className="tl-place">{d.place}</p>
                    <h3 style={{ marginTop: ".5rem" }}>{d.title}</h3>
                    <p className="tl-speaker">{d.speaker}</p>
                    <p className="tl-body">{d.body}</p>
                    <ul className="tl-high">
                      {d.highlights.map((h) => (
                        <li key={h}>{h}</li>
                      ))}
                    </ul>
                    <div className="chips">
                      {d.chapters.map((c) => (
                        <Link href={`/book/${c.slug}`} className="chip" key={c.slug}>
                          {c.label}
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          <div className="center" style={{ marginTop: "3rem" }}>
            <Link href="/workshop" className="btn btn-primary">
              그날 배운 도구 직접 써보기 →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
