import type { Block } from "@/content/types";

function One({ b }: { b: Block }) {
  switch (b.t) {
    case "p":
      return <p>{b.text}</p>;

    case "h":
      return <h3>{b.text}</h3>;

    case "quote":
      return (
        <blockquote>
          <q>{b.text}</q>
          {b.by ? <span className="by">{b.by}</span> : null}
        </blockquote>
      );

    case "photo":
      return (
        <figure className="photo">
          <span className="tag">PHOTO</span>
          <figcaption>{b.caption}</figcaption>
        </figure>
      );

    case "tip":
      return (
        <aside className="tipbox">
          {b.label ? <div className="cap">{b.label}</div> : null}
          {b.title ? <h4>{b.title}</h4> : null}
          <p>{b.text}</p>
        </aside>
      );

    case "list":
      return (
        <ul className="plain">
          {b.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );

    case "table":
      return (
        <div>
          {b.caption ? <div className="tcap">{b.caption}</div> : null}
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  {b.head.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );

    case "facts":
      return (
        <div className="facts">
          {b.title ? <h4>{b.title}</h4> : null}
          <dl>
            {b.items.map((it, i) => (
              <div className="row" key={i}>
                <dt>{it.k}</dt>
                <dd>{it.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      );

    case "steps":
      return (
        <div>
          {b.title ? <div className="tcap">{b.title}</div> : null}
          <div className="steps">
            {b.items.map((it, i) => (
              <div className="step" key={i}>
                <div className="n">{it.n}</div>
                <div>
                  <div className="head">{it.head}</div>
                  {it.body ? <div className="body">{it.body}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      );

    case "split":
      return (
        <div>
          {b.title ? <div className="tcap">{b.title}</div> : null}
          <div className="split">
            <div>
              <div className="head">{b.left.head}</div>
              <div className="body">{b.left.body}</div>
            </div>
            <div>
              <div className="head">{b.right.head}</div>
              <div className="body">{b.right.body}</div>
            </div>
          </div>
        </div>
      );

    case "sketch":
      return (
        <section className="sketch">
          <div className="cap">{b.label}</div>
          <h4>{b.title}</h4>
          {b.blocks.map((inner, i) => (
            <One b={inner} key={i} />
          ))}
        </section>
      );

    case "takeaways":
      return (
        <section className="takeaways">
          <h4>{b.title}</h4>
          <ul>
            {b.items.map((it, i) => (
              <li key={i}>
                <div className="head">{it.head}</div>
                <div className="body">{it.body}</div>
              </li>
            ))}
          </ul>
        </section>
      );
  }
}

export default function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <One b={b} key={i} />
      ))}
    </>
  );
}
