// Web Push: the service worker in public/sw.js shows the alerts the API pushes.

import { fromBase64 } from "@parryguard/sdk";

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** A VAPID public key (base64url) as the bytes PushManager wants. */
export function vapidKey(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

/** This browser's current push subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Registers the service worker, asks for permission and subscribes with the API's VAPID key. */
export async function subscribePush(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  if (!pushSupported()) throw new Error("This browser cannot receive push notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings.");
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey(vapidPublicKey) }));
  return sub.toJSON();
}

export async function unsubscribePush(): Promise<void> {
  const sub = await currentSubscription();
  await sub?.unsubscribe();
}
