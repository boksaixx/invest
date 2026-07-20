import { ImageResponse } from "next/og";
import { IconGraphic } from "@/lib/iconGraphic";

export const runtime = "edge";

export async function GET() {
  return new ImageResponse(<IconGraphic size={192} />, { width: 192, height: 192 });
}
