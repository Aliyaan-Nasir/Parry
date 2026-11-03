/** Small numeric helpers shared by the risk model. */

export const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));

/**
 * The complementary error function, from W. J. Cody's rational Chebyshev approximation as given
 * in Numerical Recipes (`erfcc`): fractional error below 1.2e-7 everywhere.
 */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** The standard normal cumulative distribution function. */
export const normCdf = (x: number): number => 0.5 * erfc(-x / Math.SQRT2);

/** Ordinary least-squares slope of `ys` against `xs`. */
export function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    num += dx * (ys[i]! - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

/** Finds x in [lo, hi] with f(x) = target for an increasing f, by bisection. */
export function bisect(f: (x: number) => number, target: number, lo: number, hi: number, iterations = 60): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < iterations; i++) {
    const m = (a + b) / 2;
    if (f(m) < target) a = m;
    else b = m;
  }
  return (a + b) / 2;
}
