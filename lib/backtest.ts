// GitHub 저장소에 자동 커밋된 백테스트 통계(data/backtest.json, 주간 1회 갱신)를 읽어온다.
// snapshot.ts와 동일한 GitHub raw-fetch 패턴 (Vercel 런타임과 GitHub Actions 스크립트 양쪽에서 사용).
import type { BacktestStats, StockTicker } from "./types";

const REPO = process.env.GITHUB_REPO || "boksaixx/invest";
const BRANCH_CANDIDATES = [process.env.GITHUB_DATA_BRANCH, "main", "master"].filter((b): b is string =>
  Boolean(b),
);

export interface BacktestSnapshot {
  generatedAt: string;
  disclaimer: string;
  entryScoreThreshold: number;
  perTicker: Partial<Record<StockTicker, BacktestStats>>;
}

export async function fetchBacktestSnapshot(): Promise<BacktestSnapshot | null> {
  for (const branch of BRANCH_CANDIDATES) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(branch)}/data/backtest.json`,
        { cache: "no-store" },
      );
      if (!res.ok) continue;
      return (await res.json()) as BacktestSnapshot;
    } catch {
      // 다음 후보 브랜치 시도
    }
  }
  return null;
}
