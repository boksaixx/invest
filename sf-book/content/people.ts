// 수료식에서 각자 이번 주를 한 단어로 표현했다. (10장)
// 책에 기록된 단어는 정확히 열넷 — 함께 간 사람의 수와 같다.
export type Word = {
  word: string;
  ko: string;
  gloss: string;
};

export const words: Word[] = [
  { word: "Breakthrough", ko: "돌파", gloss: "10%의 벽을 넘어 10배를 물었던 순간" },
  { word: "Empathize", ko: "공감", gloss: "말이 아니라 행동을 듣는 법을 배웠다" },
  { word: "Friend", ko: "친구", gloss: "\"신입생에게 급한 건 친구예요\" — 가설이 무너지던 자리" },
  { word: "Dream", ko: "꿈", gloss: "달을 목적지가 아니라 디딤돌로 삼는 일" },
  { word: "Union", ko: "연결", gloss: "이제 우리는 디자인 가족입니다" },
  { word: "Listen", ko: "경청", gloss: "4분간 끼어들지 않고 듣기만 하던 훈련" },
  { word: "Resilience", ko: "회복력", gloss: "Fail Forward — 실패를 데이터로 바꾸는 힘" },
  { word: "Confidence", ko: "자신감", gloss: "코드를 못 써도 오후엔 배포되어 있었다" },
  { word: "Adventure", ko: "모험", gloss: "열한 시간을 날아간 이유" },
  { word: "Inspired", ko: "영감", gloss: "58.6채널의 스피커 아래에서" },
  { word: "Positive", ko: "긍정", gloss: "\"Yes, And\" — 부정하지 않고 쌓는 2분" },
  { word: "Enjoy", ko: "즐거움", gloss: "프로세스가 즐거우면 아이디어도 즐거워진다" },
  { word: "Proud", ko: "뿌듯함", gloss: "어설퍼도 사용자 앞에 내놓았다는 것" },
  { word: "Motivation", ko: "동기", gloss: "월요일 아침에 무엇을 바꿀 것인가" },
];

export const closingQuote = {
  text: "스탠퍼드의 멋진 건물이 필요한 게 아닙니다. 필요한 것은 여러분의 마음속에 있습니다. 회사로, 커뮤니티로, 가족에게 돌아갈 때 그 창의력을 어떻게 쓸지 생각해 주세요. 이제 우리는 디자인 가족입니다.",
  by: "Louie Montoya, 수료식",
};
