import type { Metadata } from "next";
import Link from "next/link";
import Fog from "@/components/Fog";
import FiveWhys from "@/components/workshop/FiveWhys";
import HmwBuilder from "@/components/workshop/HmwBuilder";
import ImpactMatrix from "@/components/workshop/ImpactMatrix";
import Moonshot from "@/components/workshop/Moonshot";
import YesAnd from "@/components/workshop/YesAnd";

export const metadata: Metadata = { title: "워크숍" };

const flow = [
  { n: "01", label: "5 Why", href: "#five-whys", note: "증상에서 원인으로" },
  { n: "02", label: "HMW", href: "#hmw", note: "풀 수 있는 질문으로" },
  { n: "03", label: "Yes, And", href: "#yes-and", note: "2분간 발산" },
  { n: "04", label: "매트릭스", href: "#matrix", note: "수렴하고 한 칸 고르기" },
  { n: "05", label: "10x", href: "#moonshot", note: "문제 자체를 다시 적기" },
];

export default function Workshop() {
  return (
    <>
      <section className="band" style={{ paddingBottom: "2rem" }}>
        <Fog />
        <div className="wrap" style={{ position: "relative", zIndex: 1 }}>
          <div className="section-head">
            <p className="eyebrow">HANDS-ON</p>
            <h1 className="serif">워크숍 — 그날의 도구를 직접</h1>
            <p className="lede">
              2부의 실습은 그대로 팀 워크숍에 가져다 쓸 수 있다. 강의실에서 손으로 했던 것을
              여기서 그대로 해보세요. 입력한 내용은 어디에도 저장되지 않고, 이 화면을 벗어나면
              사라집니다.
            </p>
          </div>

          <div className="grid grid-3" style={{ marginBottom: "1rem" }}>
            {flow.map((f) => (
              <Link href={f.href} className="card" key={f.n}>
                <div style={{ display: "flex", gap: ".8rem", alignItems: "baseline" }}>
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      color: "var(--gate)",
                      fontSize: ".8rem",
                    }}
                  >
                    {f.n}
                  </span>
                  <div>
                    <div style={{ fontWeight: 600 }}>{f.label}</div>
                    <div className="dim" style={{ fontSize: ".84rem" }}>
                      {f.note}
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="band" style={{ paddingTop: "1rem" }}>
        <div className="wrap stack" style={{ ["--gap" as string]: "2.5rem" }}>
          <FiveWhys />
          <HmwBuilder />
          <YesAnd />
          <ImpactMatrix />
          <Moonshot />
        </div>
      </section>

      <section className="band band-line">
        <div className="wrap-narrow center">
          <blockquote style={{ margin: 0 }}>
            <q>
              스탠퍼드의 멋진 건물이 필요한 게 아닙니다. 필요한 것은 여러분의 마음속에 있습니다.
            </q>
            <span className="by">Louie Montoya, 수료식</span>
          </blockquote>
          <div style={{ marginTop: "2.5rem" }}>
            <Link href="/people" className="btn btn-primary">
              열넷의 단어 보러 가기 →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
