// GitHub 저장소에 자동 커밋된 최신 수집 데이터(data/latest.json)를 읽어온다.
// 브랜치명이 환경마다 다를 수 있어 후보 브랜치를 순서대로 시도한다.
import type { CollectedSnapshot } from "./types";

const REPO = process.env.GITHUB_REPO || "boksaixx/invest";
const BRANCH_CANDIDATES = [process.env.GITHUB_DATA_BRANCH, "main", "master"].filter((b): b is string =>
  Boolean(b),
);

export async function fetchLatestSnapshot(): Promise<CollectedSnapshot | null> {
  for (const branch of BRANCH_CANDIDATES) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(branch)}/data/latest.json`,
        { cache: "no-store" },
      );
      if (!res.ok) continue;
      return (await res.json()) as CollectedSnapshot;
    } catch {
      // 다음 후보 브랜치 시도
    }
  }
  return null;
}
