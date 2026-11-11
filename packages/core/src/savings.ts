/**
 * What a rescue's route choice saved: the chosen route's output against the worst quote the
 * guardian had for the same swap. Both come from the stored route comparison (the Rhea pool's
 * `get_return` and a NEAR Intents 1Click dry-run quote).
 */

export interface StoredRoutes {
  amountNear: number;
  rhea: { outUsd: number } | null;
  intents: { outUsd: number } | { unavailable: string };
  chosen: "rhea" | "intents";
}

export interface RouteSaving {
  chosen: { venue: "rhea" | "intents"; outUsd: number } | null;
  worst: { venue: "rhea" | "intents"; outUsd: number } | null;
  /** chosen − worst, 0 when only one quote was available. */
  savedUsd: number;
  quotes: { venue: "rhea" | "intents"; outUsd: number | null; unavailable: string | null }[];
}

export function routeSaving(r: StoredRoutes): RouteSaving {
  const quotes: RouteSaving["quotes"] = [
    { venue: "rhea", outUsd: r.rhea?.outUsd ?? null, unavailable: r.rhea ? null : "no Rhea quote" },
    "outUsd" in r.intents ? { venue: "intents", outUsd: r.intents.outUsd, unavailable: null } : { venue: "intents", outUsd: null, unavailable: r.intents.unavailable },
  ];
  const priced = quotes.filter((q): q is RouteSaving["quotes"][number] & { outUsd: number } => q.outUsd !== null && Number.isFinite(q.outUsd));
  const chosenQuote = priced.find((q) => q.venue === r.chosen) ?? null;
  const worstQuote = priced.length ? priced.reduce((w, q) => (q.outUsd < w.outUsd ? q : w)) : null;
  const chosen = chosenQuote ? { venue: chosenQuote.venue, outUsd: chosenQuote.outUsd } : null;
  const worst = worstQuote ? { venue: worstQuote.venue, outUsd: worstQuote.outUsd } : null;
  return { chosen, worst, savedUsd: chosen && worst ? Math.max(0, chosen.outUsd - worst.outUsd) : 0, quotes };
}
