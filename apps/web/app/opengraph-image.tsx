import { OG_SIZE, renderOgImage } from "@/lib/og";
import { OG_ALT } from "@/lib/site";

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OpenGraphImage() {
  return renderOgImage();
}
