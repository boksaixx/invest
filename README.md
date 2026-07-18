# 📈 반도체 트레이딩 AI 에이전트

삼성전자 · SK하이닉스 **단기 매매 어드바이스** 인공지능 에이전트입니다.

- 📱 **토스처럼 쉬운 화면**: 현금과 매수가만 입력하면 끝
- 🤖 **AI 이중 분석**: 룰 엔진(기술적 분석) + Claude(종합 판단) + Gemini(실시간 뉴스 수집)
- ⏰ **자동 수집**: 장중 30분 간격으로 시세·환율·해외증시·뉴스를 자동 수집/분석해 저장
- 💬 **카카오톡 알림**: 매수/매도 신호가 바뀌면 카카오톡으로 알림 (선택)
- 🛡️ **리스크 관리 내장**: 손절가 자동 계산, 1회 손실 1% 제한, 물타기 금지, 손익비 1:2 원칙

> ⚠️ 본 서비스는 투자 참고 정보이며 수익을 보장하지 않습니다. 모든 투자의 최종 판단과 책임은 본인에게 있습니다.

---

## 🚀 설치하기 (버튼만 누르면 됩니다 — 약 15분)

### 준비물: API 키 2개 만들기

**① Claude API 키** (AI 분석 담당, 유료 — 사용량만큼 과금)
1. https://console.anthropic.com 접속 → 구글 계정으로 가입/로그인
2. 왼쪽 메뉴 **API Keys** → **Create Key** 버튼 클릭
3. 나온 `sk-ant-...` 로 시작하는 긴 문자를 복사해서 메모장에 저장
4. **Billing** 메뉴에서 결제 카드 등록 (월 $5~10 정도면 충분합니다)

**② Gemini API 키** (뉴스 수집 담당, 무료 사용량으로 충분)
1. https://aistudio.google.com/apikey 접속 → 구글 계정 로그인
2. **API 키 만들기** 버튼 클릭
3. 나온 `AIza...` 로 시작하는 문자를 복사해서 메모장에 저장
> 참고: 제미나이 유료 구독(Gemini Advanced)과 API 키는 별개입니다. API 키는 무료로 발급되며 이 에이전트가 쓰는 양은 무료 한도 안에서 해결됩니다.

---

### 1단계. GitHub 설정 (자동 수집 에이전트 켜기)

1. 이 저장소(GitHub) 페이지 상단의 **Settings** 클릭
2. 왼쪽 메뉴에서 **Secrets and variables → Actions** 클릭
3. **New repository secret** 버튼을 눌러 아래 2개를 각각 추가:
   - Name: `ANTHROPIC_API_KEY` / Secret: 아까 저장한 Claude 키 붙여넣기 → **Add secret**
   - Name: `GEMINI_API_KEY` / Secret: 아까 저장한 Gemini 키 붙여넣기 → **Add secret**
4. 저장소 상단 **Actions** 탭 클릭 → 초록색 **"I understand... enable them"** 버튼이 보이면 클릭
5. 왼쪽에서 **Trading Agent** 클릭 → 오른쪽 **Run workflow** 버튼 → 초록색 **Run workflow** 클릭 (첫 실행 테스트)

✅ 이제 평일 장중(09:00~15:30) 30분마다 + 개장 전(08:30) + 마감 후(16:10) 자동으로 수집·분석이 돌아갑니다.
첫 실행 때 3개년 과거 데이터(주가/환율/해외지수)도 자동으로 채워집니다.

### 2단계. Vercel 배포 (내 전용 앱 만들기)

1. https://vercel.com 접속 → **Sign Up** → **Continue with GitHub** 로 가입
2. **Add New... → Project** 클릭
3. 목록에서 **invest** 저장소 옆의 **Import** 클릭
4. **Environment Variables** 항목을 펼쳐서 아래 2개 추가:
   - Key: `ANTHROPIC_API_KEY` / Value: Claude 키 붙여넣기
   - Key: `GEMINI_API_KEY` / Value: Gemini 키 붙여넣기
5. **Deploy** 버튼 클릭 → 1~2분 기다리면 완료 🎉
6. 완료 화면의 주소(예: `https://invest-xxx.vercel.app`)를 누르면 앱이 열립니다. **휴대폰 홈 화면에 추가**해두면 앱처럼 쓸 수 있어요 (사파리/크롬 공유 버튼 → "홈 화면에 추가")

---

## 📱 사용법

1. 앱을 열고 오른쪽 위 **"내 자산 입력"** 을 눌러 보유 현금을 입력합니다 (기본 2,000만원)
2. 주식을 사면 그 종목의 **매수 평단가**와 **수량**을 입력합니다
3. **"지금 AI 정밀 분석 받기"** 버튼을 누르면:
   - 실시간 시세 + 기술적 지표 + 실시간 뉴스 + 환율/해외증시를 모두 종합해
   - **신규매수 / 추가매수 / 보유 / 부분매도 / 전량매도 / 손절 / 관망** 중 하나를 이유와 함께 제안합니다
   - **목표가와 손절가**도 함께 알려줍니다 — 특히 손절가는 반드시 지키세요!
4. 보유 정보를 입력해두면 "지금 팔아야 할지"를, 미보유면 "지금 사야 할지"를 알려줍니다

### 매매 원칙 (에이전트에 내장된 규칙)

| 원칙 | 내용 |
|---|---|
| 손실 제한 | 1회 매매 손실은 총자산의 1% 이내 (매수 규모 자동 계산) |
| 손절 | 진입가 대비 ATR(변동폭) 기반 손절가 자동 산출, 도달 시 무조건 정리 권고 |
| 손익비 | 목표가는 손절폭의 2배 (1:2 미만이면 진입 안 함) |
| 물타기 금지 | 손실 중 추가매수 권하지 않음. 수익 중 추가매수(피라미딩)만 허용 |
| 과열 회피 | RSI 72 이상 추격매수 금지 |
| 복수 확인 | 추세 + 거래량 + 뉴스가 겹칠 때만 진입 신호 |

---

## 💬 카카오톡 알림 연결 (선택, 10분)

신호가 바뀔 때 내 카카오톡으로 메시지를 받으려면:

1. https://developers.kakao.com 접속 → 카카오 계정 로그인 → **내 애플리케이션 → 애플리케이션 추가하기** (이름: 아무거나, 예: "트레이딩알림")
2. 만든 앱 클릭 → **앱 설정 > 앱 키** 에서 **REST API 키** 복사 → 메모장에 저장
3. **제품 설정 > 카카오 로그인** → 활성화 ON → **Redirect URI 등록**: `https://localhost` 입력 후 저장
4. **제품 설정 > 카카오 로그인 > 동의항목** → "카카오톡 메시지 전송(talk_message)" 항목 → **이용 중 동의** 설정
5. 브라우저 주소창에 아래 주소를 붙여넣고 이동 (REST_API_키 부분을 본인 키로 교체):
   ```
   https://kauth.kakao.com/oauth/authorize?client_id=REST_API_키&redirect_uri=https://localhost&response_type=code&scope=talk_message
   ```
6. 동의하고 계속하면 "사이트에 연결할 수 없음" 화면이 나옵니다 — 정상입니다! 주소창을 보면 `https://localhost/?code=XXXXX` 형태인데, 이 **code= 뒤의 값**을 복사
7. 컴퓨터에서 터미널(맥: 터미널 앱 / 윈도우: PowerShell)을 열고 아래를 붙여넣어 실행 (키와 코드 교체):
   ```
   curl -X POST "https://kauth.kakao.com/oauth/token" -d "grant_type=authorization_code" -d "client_id=REST_API_키" -d "redirect_uri=https://localhost" -d "code=복사한코드"
   ```
8. 결과에서 `"refresh_token":"..."` 값을 복사
9. GitHub 저장소 → **Settings → Secrets and variables → Actions** 에 2개 추가:
   - `KAKAO_REST_KEY` = REST API 키
   - `KAKAO_REFRESH_TOKEN` = refresh_token 값

✅ 이후 매수/매도 신호가 바뀌면 "나와의 채팅"으로 알림이 옵니다.
(참고: 카카오 정책상 리프레시 토큰은 약 2개월마다 5~8번 과정을 다시 해줘야 할 수 있습니다.)

---

## ❓ 자주 묻는 질문

**Q. 자동으로 주식을 사고 파나요?**
아니요. 이 에이전트는 **조언만** 합니다. 실제 매매는 본인이 증권사 앱(MTS)에서 직접 합니다. 자동 매매는 증권사 API 인증·법적 요건이 필요해 의도적으로 제외했습니다.

**Q. 비용이 얼마나 드나요?**
GitHub Actions·Vercel·Gemini는 무료 한도로 충분합니다. Claude API만 사용량 과금인데, 하루 수십 회 분석 기준 월 $5~15 수준입니다.

**Q. 30분 자동 수집 데이터는 어디에 쌓이나요?**
이 저장소의 `data/` 폴더에 자동 커밋됩니다. `data/latest.json`(최신), `data/log/날짜.json`(일별 기록), `data/market-history.json`(3개년 주가/환율/지수)입니다.

**Q. 앱 분석과 자동 수집의 차이는?**
자동 수집(30분)은 시장 전체 관점의 신호와 뉴스를 축적하고, 앱에서 버튼을 누르면 **내 보유 현황을 반영한** 맞춤 분석이 그 자리에서 실행됩니다.

**Q. 코드를 수정하면 어떻게 반영되나요?**
GitHub에서 파일을 수정(커밋)하면 Vercel이 자동으로 다시 배포합니다. 별도 조작이 필요 없습니다.

---

## 🏗️ 구조 (개발자 참고)

```
app/                # Next.js 웹앱 (토스 스타일 대시보드)
  api/market/       # 실시간 시세 API
  api/advice/       # AI 정밀 분석 API (엔진 + Gemini 뉴스 + Claude 판단)
  api/snapshot/     # 자동 수집 데이터 조회
lib/
  market.ts         # 시세 수집 (야후 파이낸스 + 네이버 폴백)
  indicators.ts     # 기술적 지표 (RSI, MACD, 볼린저, ATR 등)
  engine.ts         # 룰 기반 매매 판단 엔진 (리스크 관리 내장)
  gemini.ts         # Gemini 실시간 뉴스 수집 (구글 검색 그라운딩)
  claude.ts         # Claude 최종 판단 (structured output)
  kakao.ts          # 카카오톡 나에게 보내기
scripts/
  collect.ts        # 30분 자동 수집 (GitHub Actions)
  backfill.ts       # 3개년 과거 데이터 적재
data/
  events.json       # 2023~2026 반도체/매크로 주요 이벤트 타임라인
.github/workflows/agent.yml  # 자동 수집 스케줄러
```
