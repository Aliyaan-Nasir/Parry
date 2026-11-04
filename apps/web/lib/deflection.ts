// The deflection drawing shared by the landing hero and the Open Graph image: a position's
// health falls toward the liquidation line, the sabre meets it, and it is turned back up.
// Coordinates are on a 640 x 360 canvas.

import { MARK } from "@/components/brand/paths";

export const CANVAS = { width: 640, height: 360 } as const;

/** The part of the canvas the hero shows: the empty band above the first guide is trimmed. */
export const HERO_VIEW = { y: 40, height: 320 } as const;

/** Where liquidation happens. */
export const LIQUIDATION_Y = 300;

/** Where the sabre meets the falling line. */
export const CONTACT = { x: 372, y: 236 } as const;

/** Health before Parry steps in: drifting, then falling. */
export const APPROACH =
  "M0 96 C 34 90, 62 98, 92 108 S 150 104, 186 118 S 246 150, 282 178 S 344 220, 372 236";

/**
 * Where the line was heading without Parry: it follows the fall (hidden under the solid line)
 * and carries on through the liquidation line.
 */
export const PROJECTED =
  "M186 118 C 222 132, 246 150, 282 178 S 344 220, 372 236 C 392 249, 414 272, 436 300 S 452 322, 458 330";

/** Where the liquidation would have happened. */
export const PROJECTED_HIT = { x: 436, y: 300 } as const;

/** Health after the parry: carried along the blade, then back up to safety. */
export const RECOVERY = "M372 236 C 390 232, 404 223, 420 206 S 468 158, 520 147 S 590 134, 624 130";

/** Where the recovery ends (the head of the line rests here in the still frame). */
export const RECOVERY_END = { x: 624, y: 130 } as const;

/** Horizontal guide lines, as fractions of the plot height. */
export const GUIDES = [0.2, 0.4, 0.6] as const;

/** Sabre placement: the mark's sabre scaled so its spine touches the contact point. */
export const SABRE_SCALE = 4.7;
const SPINE_CONTACT = { x: 16.1, y: 22.0 };
export const SABRE_TRANSLATE = {
  x: CONTACT.x - SPINE_CONTACT.x * SABRE_SCALE,
  y: CONTACT.y + 1.6 - SPINE_CONTACT.y * SABRE_SCALE,
} as const;

/** The sabre's pivot (its pommel) on the canvas, for the swing. */
export const SABRE_PIVOT = {
  x: SABRE_TRANSLATE.x + MARK.pommel.cx * SABRE_SCALE,
  y: SABRE_TRANSLATE.y + MARK.pommel.cy * SABRE_SCALE,
} as const;

export const SABRE = {
  blade: MARK.blade,
  grip: MARK.grip,
  gripWidth: MARK.gripWidth,
  guard: MARK.guard,
  guardWidth: MARK.guardWidth,
  pommel: MARK.pommel,
} as const;
