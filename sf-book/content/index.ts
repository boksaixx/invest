import { part1 } from "./part1";
import { part2a } from "./part2a";
import { part2b } from "./part2b";
import { part3 } from "./part3";
import type { Chapter } from "./types";

export const chapters: Chapter[] = [...part1, ...part2a, ...part2b, ...part3];

export const readableChapters = chapters.filter((c) => !c.pending);

export function getChapter(slug: string): Chapter | undefined {
  return chapters.find((c) => c.slug === slug);
}

export function neighbours(slug: string) {
  const i = chapters.findIndex((c) => c.slug === slug);
  return {
    prev: i > 0 ? chapters[i - 1] : undefined,
    next: i >= 0 && i < chapters.length - 1 ? chapters[i + 1] : undefined,
  };
}

export * from "./front";
export * from "./types";
