// 추적 종목 중 5년 히스토리가 비어 있는 것이 있는지 검사한다.
//
// 실행: npx tsx scripts/check-history.ts   (있으면 종료코드 1)
//
// GitHub Actions가 "지금 백필이 필요한가"를 판단하는 데 쓴다. 예전에는 백필이 주간 크론에서만
// 돌아서, 종목을 추가하면 다음 일요일까지 최대 일주일 동안 그 종목의 백테스트·국면통계·
// 상승률이 통째로 비어 있었다. 이제 15분마다 확인해 비어 있으면 바로 채운다.
import { missingHistory } from "./backfill";

const missing = missingHistory();
if (missing.length === 0) {
  console.log("✅ 추적 종목·매크로 히스토리 모두 적재됨");
  process.exit(0);
}
console.log(`⚠ 히스토리 없는 항목 ${missing.length}개: ${missing.join(", ")}`);
process.exit(1);
