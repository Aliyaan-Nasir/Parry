// The deflection drawing shared by the landing hero and the Open Graph image: a position's
// health falls toward the liquidation line, the guard from Parry's mark rises under it, and the
// line is turned back up. Coordinates are on a 640 x 360 canvas.

import { MARK } from "@/components/brand/paths";

export const CANVAS = { width: 640, height: 360 } as const;

/** The part of the canvas the hero shows: the empty band above the first guide is trimmed. */
export const HERO_VIEW = { y: 40, height: 320 } as const;

/** Where liquidation happens. */
export const LIQUIDATION_Y = 300;

/** Where the falling line meets the guard. */
export const CONTACT = { x: 372, y: 236 } as const;

/** Health before Parry steps in: drifting, then falling. */
export const APPROACH =
  "M0 96 C 34 90, 62 98, 92 108 S 150 104, 186 118 S 246 150, 282 178 S 344 220, 372 236";

/**
 * Where the line was heading without Parry: it follows the fall (hidden under the solid line)
 * and carries on through the liquidation line, behind the guard.
 */
export const PROJECTED =
  "M186 118 C 222 132, 246 150, 282 178 S 344 220, 372 236 C 392 249, 414 272, 436 300 S 452 322, 458 330";

/** Where the liquidation would have happened. */
export const PROJECTED_HIT = { x: 436, y: 300 } as const;

/** Health after the guard: turned up off its face, then back to safety. */
export const RECOVERY = "M372 236 C 384 224, 398 212, 422 198 S 470 160, 520 148 S 590 134, 624 130";

/** Where the recovery ends (the head of the line rests here in the still frame). */
export const RECOVERY_END = { x: 624, y: 130 } as const;

/** Horizontal guide lines, as fractions of the plot height. */
export const GUIDES = [0.2, 0.4, 0.6] as const;

/**
 * The guard is the mark's half disc (MARK.guard on its 32 unit grid), turned so its round face
 * points up, scaled, and set so the top of the face sits just under the contact point.
 */
export const GUARD_PATH = MARK.guard;
export const GUARD_SCALE = 4.4;
/** The guard's flat edge and the top of its round face on the 32 unit grid (from MARK.guard). */
const GUARD_FLAT_X = 14.25;
const GUARD_APEX = { x: 24.75, y: 12.5 } as const;
/** Room between the line and the guard's face. */
const GUARD_GAP = 4;
/** `translate(x y) scale(s) rotate(-90)` maps the apex (ax, ay) to (x + ay s, y - ax s). */
export const GUARD_TRANSLATE = {
  x: CONTACT.x - GUARD_APEX.y * GUARD_SCALE,
  y: CONTACT.y + GUARD_GAP + GUARD_APEX.x * GUARD_SCALE,
} as const;
export const GUARD_TRANSFORM = `translate(${GUARD_TRANSLATE.x.toFixed(2)} ${GUARD_TRANSLATE.y.toFixed(2)}) scale(${GUARD_SCALE}) rotate(-90)`;
/** The guard's flat base on the canvas (it rises from below this line). */
export const GUARD_BASE_Y = GUARD_TRANSLATE.y - GUARD_FLAT_X * GUARD_SCALE;
