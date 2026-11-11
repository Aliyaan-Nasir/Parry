"use client";

/**
 * The owner's own copy of the policy they sealed, kept only in this browser so the app can say
 * "Guarding, trigger at 1.25" back to them. The chain only ever holds the sealed bytes.
 */
export type RememberedPolicy = { triggerScore: number; triggerHealth: number; targetHealth: number; strategy: string; steps?: string[]; at: number };

const key = (account: string) => `parry-policy:${account}`;

export function rememberPolicy(account: string, policy: Omit<RememberedPolicy, "at">): void {
  try {
    localStorage.setItem(key(account), JSON.stringify({ ...policy, at: Date.now() }));
  } catch {}
}

export function readPolicy(account: string): RememberedPolicy | null {
  try {
    const raw = localStorage.getItem(key(account));
    return raw ? (JSON.parse(raw) as RememberedPolicy) : null;
  } catch {
    return null;
  }
}
