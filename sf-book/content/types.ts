export type Block =
  | { t: "p"; text: string }
  | { t: "h"; text: string }
  | { t: "quote"; text: string; by?: string }
  | { t: "photo"; caption: string }
  | { t: "tip"; label?: string; title?: string; text: string }
  | { t: "list"; items: string[]; ordered?: boolean }
  | { t: "table"; caption?: string; head: string[]; rows: string[][] }
  | { t: "facts"; title?: string; items: { k: string; v: string }[] }
  | { t: "steps"; title?: string; items: { n: string; head: string; body: string }[] }
  | { t: "sketch"; label: string; title: string; blocks: Block[] }
  | { t: "split"; title?: string; left: { head: string; body: string }; right: { head: string; body: string } }
  | { t: "takeaways"; title: string; items: { head: string; body: string }[] };

export type Chapter = {
  slug: string;
  num: string;
  part: 1 | 2 | 3;
  kicker: string;
  meta: string;
  title: string;
  dek: string;
  keyMessage: string;
  context: string;
  page: number;
  blocks: Block[];
  /** 원고를 아직 옮기지 못한 장. 목차에는 나오되 본문은 '준비 중'으로 표시된다. */
  pending?: boolean;
};

export type Part = {
  n: 1 | 2 | 3;
  label: string;
  title: string;
  dek: string;
  eyebrow: string;
};
