import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type CertificateError, certificateHash, checkInput, issueCertificate } from "../src/lib/certificates";
import { migrate } from "../src/lib/db";
import { accountPosition, heatmapRow, type PricedAsset } from "../src/lib/heatmap";
import { changes24h, hyperliquidFunding } from "../src/lib/markets";

const asset = (tokenId: string, o: { vr: number; extra?: number; price: number; near: boolean; decimals: number; supplyRatio?: number }): [string, PricedAsset] => [
  tokenId,
  {
    asset: {
      tokenId,
      supplyApr: 0,
      borrowApr: 0,
      utilization: 0,
      volatilityRatio: o.vr,
      extraDecimals: o.extra ?? 0,
      // Supplied shares are worth `supplyRatio` of their balance (accrued interest).
      supplied: { shares: "1000", balance: String(1000 * (o.supplyRatio ?? 1)) },
      borrowed: { shares: "1000", balance: "1000" },
      canBorrow: true,
      canUseAsCollateral: true,
    },
    price: { tokenId, priceUsd: o.price, nearLinked: o.near, source: "test" },
    decimals: o.decimals,
  },
];

describe("heatmap accounts", () => {
  const assets = new Map([
    asset("wrap.near", { vr: 0.75, price: 3, near: true, decimals: 24, supplyRatio: 1.1 }),
    asset("usdc", { vr: 0.95, extra: 12, price: 1, near: false, decimals: 6 }),
  ]);

  test("reads a borrower from raw shares, at the asset's share price, with its liquidation price", () => {
    const raw = {
      account_id: "alice.near",
      positions: { REGULAR: { RegularPosition: { collateral: { "wrap.near": (100n * 10n ** 24n).toString() }, borrowed: { usdc: (150n * 10n ** 18n).toString() } } } },
    };
    const p = accountPosition(raw, assets)!;
    expect(p.collateral[0]!.amount).toBeCloseTo(110, 6);
    expect(p.debt[0]!.amount).toBeCloseTo(150, 6);
    const row = heatmapRow("alice.near", p, 3);
    // Health 110 × 3 × 0.75 / (150 / 0.95) = 1.5675; liquidation at 3 / 1.5675.
    expect(row.health).toBeCloseTo(1.5675, 4);
    expect(row.liqPrice!).toBeCloseTo(3 / 1.5675, 4);
    expect(row.driverCollateralUsd).toBeCloseTo(330, 6);
    // Weighted exposure in NEAR: 110 × 0.75; the ratios are value-weighted.
    expect(row.exposure!).toBeCloseTo(82.5, 6);
    expect(row.collateralRatio).toBeCloseTo(0.75, 9);
    expect(row.debtRatio).toBeCloseTo(0.95, 9);
  });

  test("an account without debt, or with only unknown assets, is not a borrower", () => {
    expect(accountPosition({ account_id: "a", positions: { REGULAR: { RegularPosition: { collateral: { "wrap.near": "1" }, borrowed: {} } } } }, assets)).toBeNull();
    expect(accountPosition({ account_id: "b", positions: { REGULAR: { RegularPosition: { collateral: {}, borrowed: { other: "5" } } } } }, assets)).toBeNull();
    expect(accountPosition({ account_id: "c" }, assets)).toBeNull();
  });
});

describe("market reads", () => {
  test("24 hour changes come from Binance's tickers, keyed by Pyth feed", async () => {
    const fetchFn = (async () =>
      Response.json([
        { symbol: "NEARUSDT", priceChangePercent: "-4.5" },
        { symbol: "BTCUSDT", priceChangePercent: "1.25" },
      ])) as unknown as typeof fetch;
    const m = await changes24h(fetchFn);
    expect(m.get("c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750")).toEqual({ change: -0.045, symbol: "NEARUSDT" });
    expect(m.size).toBe(2);
  });

  test("Hyperliquid funding: the live rate and the last day annualized", async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string };
      if (body.type === "metaAndAssetCtxs") return Response.json([{ universe: [{ name: "BTC" }, { name: "NEAR" }] }, [{ funding: "0.0001" }, { funding: "0.0000125" }]]);
      return Response.json([{ fundingRate: "0.00001" }, { fundingRate: "0.00003" }]);
    }) as unknown as typeof fetch;
    const f = await hyperliquidFunding(fetchFn);
    expect(f.fundingHourly).toBe(0.0000125);
    expect(f.funding24hApr!).toBeCloseTo(0.00002 * 24 * 365, 9);
    expect(f.source).toContain("fundingHistory");
  });
});

describe("margin decisions", () => {
  test("watch early, top up from the fund once the vault asks, no-op without the fund", async () => {
    const { marginDecision } = await import("../src/keeper");
    const base = { notionalUsd: 1000, accountValueUsd: 150, early: 0.2, target: 0.4, insurance: true };
    expect(marginDecision({ ...base, ratio: null, needsMargin: false }).action).toBe("none");
    expect(marginDecision({ ...base, ratio: 0.5, needsMargin: false }).action).toBe("none");
    expect(marginDecision({ ...base, ratio: 0.15, needsMargin: false }).action).toBe("watch");
    const top = marginDecision({ ...base, ratio: 0.15, needsMargin: true });
    expect(top).toMatchObject({ action: "top_up", amountUsd: 250 });
    expect(marginDecision({ ...base, ratio: 0.15, needsMargin: true, insurance: false }).action).toBe("unsupported");
  });
});

describe("certificate requests", () => {
  test("are checked before anything runs", () => {
    expect(checkInput({ account: "0ua.testnet", reader: "lender.testnet", threshold: 1.2, ttlSecs: 3600 })).toMatchObject({ venue: "rhea", anchor: false });
    expect(() => checkInput({ account: "0ua.testnet", reader: "lender.testnet", threshold: 0.9, ttlSecs: 3600 })).toThrow("threshold");
    expect(() => checkInput({ account: "0ua.testnet", reader: "lender.testnet", threshold: 1.2, ttlSecs: 10 })).toThrow("ttlSecs");
    expect(() => checkInput({ account: "0ua.testnet", reader: "x", threshold: 1.2, ttlSecs: 3600 })).toThrow("reader");
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("database flows", () => {
  const sql = postgres(url ?? "postgres://invalid", { onnotice: () => {} });

  beforeAll(async () => {
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
  });
  afterAll(() => sql.end());

  const input = { account: "0ua.testnet", reader: "lender.testnet", threshold: 1.2, ttlSecs: 3600, venue: "rhea", anchor: false };

  test("certificates: 503 until the enclave has the mode, 422 when refused, stored when signed", async () => {
    const run = async () => ({ output: { refused: "health is below the threshold" }, tx: "out-1" }) as never;
    const err = await issueCertificate(sql, input, "0ua.testnet", { modes: () => ["guardian"], run }).catch((e) => e as CertificateError);
    expect((err as CertificateError).status).toBe(503);
    const refused = await issueCertificate(sql, input, "0ua.testnet", { modes: () => ["certificate"], run }).catch((e) => e as CertificateError);
    expect((refused as CertificateError).status).toBe(422);
    const certificate_json = JSON.stringify({ kind: "parry-health-certificate", version: 1, account: "0ua.testnet", reader: "lender.testnet", expires_at: 1_900_000_000 });
    const signed = async () => ({ output: { certificate_json, signature: "c2ln", public_key: "ed25519:k", report_json: "{}", report_signature: "c2ln" }, tx: "out-2" }) as never;
    const c = await issueCertificate(sql, input, "0ua.testnet", { modes: () => ["certificate"], run: signed });
    expect(c.hash).toBe(certificateHash(certificate_json));
    expect(c.anchorTx).toBeNull();
    const [row] = await sql`SELECT outlayer_tx, expires_at FROM certificates WHERE hash = ${c.hash}`;
    expect(row!.outlayer_tx).toBe("out-2");
    // Anchoring without a wallet says so instead of pretending.
    const noWallet = await issueCertificate(sql, { ...input, anchor: true }, "0ua.testnet", { modes: () => ["certificate"], run: signed, anchorer: null }).catch((e) => e as CertificateError);
    expect((noWallet as CertificateError).status).toBe(503);
  });

  test("incidents: one price move's alerts are one incident and one message; a later critical alert escalates once", async () => {
    const { deliver } = await import("../src/alerts");
    const sent: string[] = [];
    const send = async (_sql: unknown, account: string, _tag: string, title: string) => {
      sent.push(`${account}: ${title}`);
    };
    await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES
      ('0ua.testnet', 'risk', 'warning', 'risk:0ua.testnet:rhea:main', 'Rhea: risk 55', 'b'),
      ('0ua.testnet', 'health', 'warning', 'health:0ua.testnet:rhea:main', 'Rhea: health 1.2', 'b'),
      ('0ua.testnet', 'risk', 'info', 'risk:0ua.testnet:hyperliquid:NEAR', 'Perp: risk 30', 'b'),
      ('0ub.testnet', 'risk', 'warning', 'risk:0ub.testnet:rhea:main', 'Other: risk 52', 'b')`;
    expect(await deliver(sql as never, send as never)).toBe(2);
    expect(sent).toContain("0ua.testnet: 2 positions affected: Rhea: risk 55");
    const [i] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM incidents WHERE account = '0ua.testnet'`;
    expect(i!.n).toBe(1);
    await sql`INSERT INTO alerts (account, kind, severity, key, title, body) VALUES ('0ua.testnet', 'health', 'critical', 'health:0ua.testnet:aave:main', 'Aave: health 1.03', 'b')`;
    expect(await deliver(sql as never, send as never)).toBe(1);
    expect(sent.at(-1)).toContain("Aave: health 1.03");
    expect(await deliver(sql as never, send as never)).toBe(0);
    // Every alert resolves: the incident closes.
    await sql`UPDATE alerts SET status = 'resolved' WHERE account = '0ua.testnet'`;
    await deliver(sql as never, send as never);
    const [closed] = await sql`SELECT closed_at FROM incidents WHERE account = '0ua.testnet'`;
    expect(closed!.closed_at).not.toBeNull();
  });

  test("the risk engine alerts watchers at their thresholds and takes cascade pressure from the heatmap", async () => {
    const { scoreAll } = await import("../src/risk");
    const now = Date.now();
    for (let i = 0; i <= 48; i++) await sql`INSERT INTO prices (asset, source, t, price) VALUES ('NEAR', 'oracle', ${new Date(now - (48 - i) * 300_000)}, ${3 - 0.002 * i}) ON CONFLICT DO NOTHING`;
    const lending = (collateral: number, debt: number) => ({
      position: {
        collateral: [{ symbol: "wNEAR", amount: collateral, priceUsd: 2.9, volatilityRatio: 0.75, driver: true }],
        debt: [{ symbol: "USDC", amount: debt, priceUsd: 1, volatilityRatio: 0.95, driver: false }],
      },
      protected: false,
      watched: true,
    });
    await sql`INSERT INTO positions (id, account, venue, label, raw, collateral_usd, debt_usd) VALUES ('bob.testnet:rhea:main', 'bob.testnet', 'rhea', 'Rhea wNEAR/USDC', ${sql.json(lending(100, 200) as never)}, 290, 200)`;
    await sql`INSERT INTO watched (owner, account, label, thresholds) VALUES ('0uwatcher.testnet', 'bob.testnet', 'Bob', ${sql.json({ score: 90, health: 1.3 })})`;
    await sql`INSERT INTO heatmap_accounts (network, account, collateral_usd, debt_usd, driver_collateral_usd, liq_price) VALUES ('mainnet', 'whale.near', 5000000, 3500000, 5000000, 2.85)`;
    await scoreAll(sql);
    const alerts = await sql<{ account: string; kind: string; title: string }[]>`SELECT account, kind, title FROM alerts WHERE key LIKE '%bob.testnet%'`;
    // Health 100 × 2.9 × 0.75 × 0.95 / 200 = 1.033: under the watcher's 1.3; the watched account itself gets nothing.
    expect(alerts.map((a) => a.account)).toEqual(["0uwatcher.testnet", "0uwatcher.testnet"].slice(0, alerts.length));
    expect(alerts.some((a) => a.kind === "health" && a.title.startsWith("Bob: Rhea"))).toBe(true);
    const [m] = await sql<{ payload: { tremor: { regime: string }; cascade: { source: string; accounts: number } } }[]>`SELECT payload FROM reports WHERE kind = 'market' ORDER BY run_id DESC LIMIT 1`;
    expect(m!.payload.cascade.source).toBe("heatmap");
    expect(m!.payload.cascade.accounts).toBe(1);
    expect(["calm", "stressed", "panic"]).toContain(m!.payload.tremor.regime);
    const queued = await sql`SELECT 1 FROM guardian_queue WHERE account = 'bob.testnet'`;
    expect(queued.length).toBe(0);
  });
});
