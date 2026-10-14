// 예측 모델(data/model.json) 불러오기 — 주간 재학습 결과가 GitHub에 커밋되면 재배포 없이 반영되도록
// 원격(raw.githubusercontent)을 먼저 읽고, 실패하면 빌드에 포함된 파일을 쓴다.
// 원격이 빌드에 포함된 것보다 오래됐으면(새 코드가 막 배포됐는데 원격은 아직 옛 모델) 빌드 쪽을 쓴다.
// MODEL_SOURCE=bundled 이면 원격을 읽지 않는다(로컬 검증용).
import bundled from "@/data/model.json";
import type { TwoStockModel } from "./predict";

const REPO = process.env.GITHUB_REPO || "boksaixx/invest";
const BRANCHES = [process.env.GITHUB_DATA_BRANCH, "main", "master"].filter((b): b is string => Boolean(b));
let cache: { model: TwoStockModel; at: number } | null = null;
const TTL = 60 * 60_000;

export async function loadModel(): Promise<TwoStockModel> {
  if (cache && Date.now() - cache.at < TTL) return cache.model;
  const local = bundled as unknown as TwoStockModel;
  for (const br of process.env.MODEL_SOURCE === "bundled" ? [] : BRANCHES) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(br)}/data/model.json`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const m = (await res.json()) as TwoStockModel;
      if (m?.day?.open?.coef && m?.swing?.coef && String(m.generatedAt ?? "") >= String(local.generatedAt ?? "")) {
        cache = { model: m, at: Date.now() };
        return m;
      }
    } catch {
      // 다음 브랜치
    }
  }
  cache = { model: local, at: Date.now() };
  return local;
}
