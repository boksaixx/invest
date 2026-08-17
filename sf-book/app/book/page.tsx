import type { Metadata } from "next";
import Toc from "@/components/Toc";
import Fog from "@/components/Fog";
import { chapters } from "@/content";
import { parts } from "@/content/front";

export const metadata: Metadata = { title: "차례" };

export default function BookIndex() {
  return (
    <section className="band">
      <Fog />
      <div className="wrap" style={{ position: "relative", zIndex: 1 }}>
        <div className="section-head">
          <p className="eyebrow">CONTENTS</p>
          <h1 className="serif">차례</h1>
          <p className="lede">
            장마다 첫머리에 &lsquo;핵심 메시지&rsquo;와 &lsquo;맥락&rsquo;을 두었다. 그 두 상자만
            읽어도 강의실에 앉아 있던 것과 같은 출발선에 설 수 있다.
          </p>
        </div>
        <Toc parts={parts} chapters={chapters} />
      </div>
    </section>
  );
}
