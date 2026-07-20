import { ImageResponse } from "next/og";
import { IconGraphic } from "@/lib/iconGraphic";

export const runtime = "edge";

export async function GET() {
  return new ImageResponse(<IconGraphic size={512} />, { width: 512, height: 512 });
}
