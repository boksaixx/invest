import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Blocks from "@/components/Blocks";
import ReadMark from "@/components/ReadMark";
import ReadingProgress from "@/components/ReadingProgress";
import { chapters, getChapter, neighbours } from "@/content";

export function generateStaticParams() {
  return chapters.map((c) => ({ slug: c.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const c = getChapter(params.slug);
  if (!c) return { title: "찾을 수 없는 장" };
  return { title: c.title, description: c.dek || c.keyMessage };
}

export default function ChapterPage({ params }: { params: { slug: string } }) {
  const chapter = getChapter(params.slug);
  if (!chapter) notFound();

  const { prev, next } = neighbours(chapter.slug);

  return (
    <article>
      <ReadingProgress />

      <header className="chapter-hero">
        <div className="wrap-narrow" style={{ position: "relative" }}>
          <span className="chapter-num serif" aria-hidden="true">
            {chapter.num}
          </span>
          <p className="eyebrow">{chapter.kicker}</p>
          <h1 className="chapter-title">{chapter.title}</h1>
          {chapter.dek ? (
            <p className="lede" style={{ marginTop: "1.4rem", maxWidth: "36rem" }}>
              {chapter.dek}
            </p>
          ) : null}
          <p
            className="dim"
            style={{
              marginTop: "1.6rem",
              fontFamily: "var(--mono)",
              fontSize: ".72rem",
              letterSpacing: ".1em",
            }}
          >
            {chapter.meta} · p.{chapter.page}
          </p>
        </div>
      </header>

      {chapter.pending ? (
        <div className="wrap-narrow" style={{ padding: "4rem 0 6rem" }}>
          <div className="tipbox">
            <div className="cap">원고 준비 중</div>
            <h4>이 장은 아직 웹으로 옮기지 않았습니다</h4>
            <p>
              인쇄본 {chapter.page}쪽부터 실린 내용입니다. 원고를 넘겨주시면 나머지 장과 같은
              형식으로 이어 붙일 수 있습니다.
            </p>
          </div>
          <div style={{ marginTop: "2rem" }}>
            <Link href="/book" className="btn btn-quiet">
              ← 차례로
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="wrap-narrow" style={{ paddingTop: "2.5rem" }}>
            <div className="stack" style={{ ["--gap" as string]: "1.2rem" }}>
              {chapter.keyMessage ? (
                <div className="keybox">
                  <div className="cap">이 장의 핵심 메시지</div>
                  <p>{chapter.keyMessage}</p>
                </div>
              ) : null}
              {chapter.context ? (
                <p className="contextbox">맥락 · {chapter.context}</p>
              ) : null}
            </div>
          </div>

          <div className="wrap-narrow prose">
            <Blocks blocks={chapter.blocks} />
            <ReadMark slug={chapter.slug} />
          </div>
        </>
      )}

      <div className="wrap-narrow">
        <nav className="chapnav">
          {prev ? (
            <Link href={`/book/${prev.slug}`}>
              <div className="dirn">← 이전</div>
              <div className="ttl">{prev.title}</div>
            </Link>
          ) : (
            <Link href="/book">
              <div className="dirn">← 차례</div>
              <div className="ttl">전체 목차</div>
            </Link>
          )}
          {next ? (
            <Link href={`/book/${next.slug}`} className="next">
              <div className="dirn">다음 →</div>
              <div className="ttl">{next.title}</div>
            </Link>
          ) : (
            <Link href="/people" className="next">
              <div className="dirn">마지막 →</div>
              <div className="ttl">이번 주를 한 단어로</div>
            </Link>
          )}
        </nav>
      </div>
    </article>
  );
}
