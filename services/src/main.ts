/** Starts one service: `bun src/main.ts <name>` or SERVICE=<name>. */

export {};

const service = process.argv[2] ?? process.env.SERVICE;
const services: Record<string, () => Promise<{ main: () => Promise<void> }>> = {
  monitor: () => import("./monitor"),
  risk: () => import("./risk"),
  guardian: () => import("./guardian"),
  keeper: () => import("./keeper"),
  relayer: () => import("./relayer"),
  indexer: () => import("./indexer"),
  alerts: () => import("./alerts"),
  topup: () => import("./topup"),
};

const load = service ? services[service] : undefined;
if (!load) {
  console.error(`usage: bun src/main.ts <${Object.keys(services).join("|")}>`);
  process.exit(2);
}
process.env.SERVICE = service;
await (await load()).main();
