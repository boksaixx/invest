export type Day = {
  date: string;
  dow: string;
  label: string;
  title: string;
  place: string;
  speaker: string;
  body: string;
  chapters: { slug: string; label: string }[];
  highlights: string[];
  accent: "fog" | "gate" | "cardinal" | "bay" | "moon";
};

export const days: Day[] = [
  {
    date: "06.22",
    dow: "SUN",
    label: "DAY 0",
    title: "빅테크 3사 현직자 인터뷰",
    place: "SAN FRANCISCO BAY AREA",
    speaker: "Google · Meta · Apple 현직자",
    body: "구글(YouTube팀 SW엔지니어)·메타(광고팀 엔지니어)·애플(17년 차 현직자). AI 도입 수준, 조직 문화, 인력 운용의 실제를 듣다.",
    chapters: [
      { slug: "ch01", label: "01 구글" },
      { slug: "ch02", label: "02 메타" },
      { slug: "ch03", label: "03 애플" },
      { slug: "ch04", label: "04 세 회사를 나란히" },
    ],
    highlights: [
      "\"AI가 없으면 개발 자체가 안 되는 구조거든요\"",
      "메타 — 이번 평가부터 AI 활용이 공식 항목에",
      "애플 — \"제가 17년 차인데, 아직 팀에서 막내입니다\"",
      "공통 병목은 모델이 아니라 데이터였다",
    ],
    accent: "bay",
  },
  {
    date: "06.23",
    dow: "MON",
    label: "DAY 1",
    title: "문샷 싱킹 & 혁신 워크숍",
    place: "STANFORD d.SCHOOL",
    speaker: "Seamus Yu Harte — d.school 학습경험디자인 책임자",
    body: "NASA와 X 문샷 팩토리, '실용적 비실용성'. 초상화 드로잉, 문샷 브레인스토밍, 미래 신문 실습.",
    chapters: [{ slug: "ch05", label: "05 문샷 싱킹" }],
    highlights: [
      "눈을 떼지 않고 그리는 1분 초상화",
      "NASA의 세 계단 — Mercury · Gemini · Apollo",
      "\"운전을 더 안전하게\"가 아니라 \"운전자를 없애자\"",
      "김치와 케첩, 그리고 젤리의 법칙",
    ],
    accent: "moon",
  },
  {
    date: "06.24",
    dow: "TUE",
    label: "DAY 2",
    title: "디자인 씽킹 기초 & 공감 인터뷰",
    place: "STANFORD d.SCHOOL",
    speaker: "Louie Montoya — d.school",
    body: "저니맵, 5 Why, HMW 질문, 브레인스토밍, 스탠퍼드 재학생 공감 인터뷰 시연과 실전.",
    chapters: [{ slug: "ch06", label: "06 공감" }],
    highlights: [
      "\"가장 최근에 빨래했던 때를 처음부터 끝까지\"",
      "문제는 '빨래'가 아니라 '빼앗긴 시간'이었다",
      "5 Why — 세탁기가 만든 고립",
      "학생 식당으로 흩어져 Z세대를 인터뷰하다",
    ],
    accent: "cardinal",
  },
  {
    date: "06.25",
    dow: "WED",
    label: "DAY 3",
    title: "창의성, AI 음악, ChatGPT 디자인",
    place: "STANFORD d.SCHOOL · CCRMA",
    speaker: "Louie Montoya · 김기현 (CCRMA) · Chester Cho (전 OpenAI)",
    body: "Yes, And 브레인스토밍과 임팩트 매트릭스, CCRMA 김기현 연구원의 AI 음악 특강, 전 OpenAI 디자이너 Chester Cho의 ChatGPT 비하인드.",
    chapters: [
      { slug: "ch07", label: "07 Yes, And" },
      { slug: "ch08", label: "08 AI와 음악" },
      { slug: "ch09", label: "09 ChatGPT" },
    ],
    highlights: [
      "2분의 침묵 vs 2분의 폭발",
      "58.6채널 스피커 아래에서 들은 AI 음악의 한계",
      "네모 커서의 반대 — 동그라미",
      "\"서버실에 불이 났다\"는 출시 전야",
    ],
    accent: "gate",
  },
  {
    date: "06.26",
    dow: "THU",
    label: "DAY 4",
    title: "AI 프로토타이핑 & 사용자 테스트 & 수료식",
    place: "STANFORD d.SCHOOL",
    speaker: "Jeung Lee · Louie Montoya",
    body: "AI 기반 프로토타이핑(Claude Code · GitHub · Vercel), 프로토타입 사용자 테스트, Fail Forward 회고, 수료식.",
    chapters: [{ slug: "ch10", label: "10 만들면서 배우기" }],
    highlights: [
      "브라우저 탭 4개로 2시간 반 만에 배포",
      "\"신입생에게 급한 건 친구예요\" — 무너진 가설",
      "PersonaLab, 가상 사용자 10만 명",
      "\"이제 우리는 디자인 가족입니다\"",
    ],
    accent: "fog",
  },
];
