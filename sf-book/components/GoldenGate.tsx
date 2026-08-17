/**
 * 금문교 실루엣. 히어로 바닥에 앉는 장식이라 정확한 도면이 아니라 인상을 노린다.
 * 케이블은 두 탑 사이를 늘어지는 현수선, 행어(수직 케이블)는 그 곡선에서 계산해 그린다.
 */

const W = 1440;
const DECK = 196; // 상판 높이
const TOWER_TOP = 16;
const T1 = 372;
const T2 = 1068;
const ANCHOR_Y = 150;
const SAG = 150; // 두 탑 사이 케이블이 가장 낮게 내려오는 y

/**
 * 아래 path가 그리는 2차 베지에와 같은 곡선. 제어점 y를 2*SAG-TOWER_TOP으로 두면
 * 곡선의 중앙이 정확히 SAG를 지난다 — 행어가 케이블에 붙어 보이려면 같은 식을 써야 한다.
 */
function cableY(x: number) {
  const t = (x - T1) / (T2 - T1);
  const u = 2 * (1 - t) * t;
  return TOWER_TOP + 2 * u * (SAG - TOWER_TOP);
}

/** 바깥쪽(앵커 ↔ 탑) 구간의 직선 케이블 위 y */
function sideY(x: number, from: number, to: number, yFrom: number, yTo: number) {
  const t = (x - from) / (to - from);
  return yFrom + (yTo - yFrom) * t;
}

function hangers() {
  const lines: { x: number; y: number }[] = [];
  for (let x = T1 + 26; x < T2; x += 26) lines.push({ x, y: cableY(x) });
  for (let x = 40; x < T1; x += 26)
    lines.push({ x, y: sideY(x, 0, T1, ANCHOR_Y, TOWER_TOP) });
  for (let x = T2 + 26; x < W; x += 26)
    lines.push({ x, y: sideY(x, T2, W, TOWER_TOP, ANCHOR_Y) });
  return lines.filter((l) => l.y < DECK - 4);
}

function Tower({ x }: { x: number }) {
  const w = 15;
  const gap = 30;
  return (
    <g>
      <rect x={x - gap / 2 - w} y={TOWER_TOP} width={w} height={DECK - TOWER_TOP} />
      <rect x={x + gap / 2} y={TOWER_TOP} width={w} height={DECK - TOWER_TOP} />
      {[40, 84, 132].map((y) => (
        <rect key={y} x={x - gap / 2 - w} y={y} width={gap + w * 2} height={7} />
      ))}
      <rect x={x - gap / 2 - w - 5} y={TOWER_TOP} width={gap + w * 2 + 10} height={6} />
    </g>
  );
}

export default function GoldenGate({ className }: { className?: string }) {
  const hs = hangers();
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} 260`}
      preserveAspectRatio="xMidYMax meet"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {/* 상판과 그 아래 구조 */}
      <rect x="0" y={DECK} width={W} height="7" />
      <rect x="0" y={DECK + 12} width={W} height="3" opacity="0.55" />

      {/* 주 케이블 */}
      <path
        d={`M0 ${ANCHOR_Y} L${T1} ${TOWER_TOP} Q${(T1 + T2) / 2} ${
          SAG * 2 - TOWER_TOP
        } ${T2} ${TOWER_TOP} L${W} ${ANCHOR_Y}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
      />

      {/* 행어 */}
      <g opacity="0.75">
        {hs.map((h, i) => (
          <rect key={i} x={h.x} y={h.y} width="2.4" height={DECK - h.y} />
        ))}
      </g>

      <Tower x={T1} />
      <Tower x={T2} />

      {/* 물에 잠긴 교각과 언덕 */}
      <rect x={T1 - 40} y={DECK + 15} width="80" height="46" opacity="0.9" />
      <rect x={T2 - 40} y={DECK + 15} width="80" height="46" opacity="0.9" />
      <path
        d={`M0 ${DECK + 15} Q120 ${DECK - 26} 250 ${DECK + 15} L250 260 L0 260 Z`}
        opacity="0.95"
      />
      <path
        d={`M${W} ${DECK + 15} Q${W - 150} ${DECK - 40} ${W - 320} ${
          DECK + 15
        } L${W - 320} 260 L${W} 260 Z`}
        opacity="0.95"
      />
    </svg>
  );
}
