// PWA 아이콘용 그래픽(상승 막대 3개) — /app/icon-192, /app/icon-512 라우트에서 공용으로 사용.
// 마스커블 아이콘 규격(안전 영역 = 캔버스 중앙 80%)을 감안해 그래픽을 중앙에 여백을 두고 배치한다.
export function IconGraphic({ size }: { size: number }) {
  const barW = size * 0.13;
  const gap = size * 0.08;
  const heights = [0.32, 0.5, 0.68].map((h) => h * size * 0.5);
  return (
    <div
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg, #3182f6, #1b64da)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        gap,
        padding: size * 0.22,
      }}
    >
      {heights.map((h, i) => (
        <div
          key={i}
          style={{
            width: barW,
            height: h,
            background: "#ffffff",
            borderRadius: barW * 0.3,
          }}
        />
      ))}
    </div>
  );
}
