"use client";

import Link from "next/link";
import { useReadProgress } from "@/lib/progress";
import type { Chapter, Part } from "@/content/types";

export default function Toc({
  parts,
  chapters,
}: {
  parts: Part[];
  chapters: Chapter[];
}) {
  const { read, ready, reset } = useReadProgress();
  const readable = chapters.filter((c) => !c.pending);
  const done = readable.filter((c) => read.includes(c.slug)).length;
  const pct = readable.length ? Math.round((done / readable.length) * 100) : 0;

  return (
    <>
      <div
        className="card"
        style={{
          display: "flex",
          gap: "1.2rem",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <div>
          <p className="eyebrow eyebrow-fog">나의 진도</p>
          <p style={{ marginTop: ".5rem", fontSize: "1.05rem" }}>
            {ready ? (
              <>
                <strong style={{ color: "var(--moon)" }}>
                  {done} / {readable.length}장
                </strong>{" "}
                <span className="dim">· {pct}%</span>
              </>
            ) : (
              <span className="dim">불러오는 중…</span>
            )}
          </p>
          <p className="dim" style={{ fontSize: ".82rem", marginTop: ".3rem" }}>
            이 기기에만 저장됩니다. 장 끝의 &ldquo;다 읽었어요&rdquo;를 누르면 채워집니다.
          </p>
        </div>
        <div style={{ flex: "1 1 12rem", minWidth: "10rem" }}>
          <div
            style={{
              height: 6,
              borderRadius: 999,
              background: "rgba(255,255,255,.09)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background: "linear-gradient(90deg,var(--gate-deep),var(--gate-bright))",
                transition: "width .4s var(--ease)",
              }}
            />
          </div>
          {done > 0 ? (
            <button
              className="btn btn-quiet btn-sm"
              style={{ marginTop: ".8rem" }}
              onClick={reset}
            >
              진도 지우기
            </button>
          ) : null}
        </div>
      </div>

      {parts.map((part) => {
        const list = chapters.filter((c) => c.part === part.n);
        return (
          <section className="toc-part" key={part.n}>
            <div>
              <p className="eyebrow">{part.label}</p>
              <h2 className="serif" style={{ marginTop: ".7rem", fontSize: "1.7rem" }}>
                {part.title}
              </h2>
              <p className="dim" style={{ marginTop: ".7rem", fontSize: ".9rem" }}>
                {part.dek}
              </p>
              <p
                className="eyebrow eyebrow-fog"
                style={{ marginTop: "1rem", fontSize: ".62rem" }}
              >
                {part.eyebrow}
              </p>
            </div>

            <div>
              {list.map((c) =>
                c.pending ? (
                  <div className="toc-row" data-pending="true" key={c.slug}>
                    <span className="no">{c.num}</span>
                    <span>
                      <span className="t">{c.title}</span>
                      <span className="d">원고 준비 중</span>
                    </span>
                    <span className="pg">p.{c.page}</span>
                  </div>
                ) : (
                  <Link
                    href={`/book/${c.slug}`}
                    className="toc-row"
                    data-done={read.includes(c.slug)}
                    key={c.slug}
                  >
                    <span className="no">{c.num}</span>
                    <span>
                      <span className="t">{c.title}</span>
                      <span className="d">{c.dek}</span>
                    </span>
                    <span className="pg">p.{c.page}</span>
                  </Link>
                )
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}
