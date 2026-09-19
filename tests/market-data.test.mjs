import test from "node:test";
import assert from "node:assert/strict";
import { parseSnapshot, snapshotUrls } from "../market-data.js";

const snapshot = { schemaVersion: 2, generatedAt: "2026-09-15T22:00:00.000Z", fx: { rate: 7.2, fx_date: "2026-09-15", source: "Frankfurter", fetched_at: "2026-09-15T22:00:00.000Z" }, symbols: { QQQI: { price: { symbol: "QQQI", price: 100, price_date: "2026-09-15", source: "Yahoo Finance Chart", fetched_at: "2026-09-15T22:00:00.000Z" }, price_status: "valid", expected_price_date: "2026-09-15", dividends: { data: [{ ex_date: "2026-09-01", amount: 1 }], source: "test", fetched_at: "2026-09-15T22:00:00.000Z" }, dividend_rate: { rate: .14, data_date: "2026-08-31", kind: "distribution_rate", source: "NEOS official Distribution Rate" } } } };

test("v2 snapshot exposes dated price, FX and dividend-rate records", () => {
  assert.equal(parseSnapshot(snapshot, "QQQI", "PRICE").price_date, "2026-09-15");
  assert.equal(parseSnapshot(snapshot, "QQQI", "DIVIDEND_RATE").kind, "distribution_rate");
  assert.equal(parseSnapshot(snapshot, "", "FX").fx_date, "2026-09-15");
  assert.throws(() => parseSnapshot({ schemaVersion: 1 }, "QQQI", "PRICE"), /格式无效/);
});
test("Pages reads both deployment and repository copies", () => {
  assert.equal(snapshotUrls({ hostname: "dingdinglean.github.io", pathname: "/tangping-dividend-ding/" }).length, 2);
  assert.equal(snapshotUrls({ hostname: "localhost", pathname: "/" }).length, 1);
});

test("QNDX normalization preserves the decimal yield unit and published type", () => {
  const qndxSnapshot = {
    schemaVersion: 2,
    symbols: {
      QNDX: {
        dividend_rate: {
          rate: 0.0044,
          data_date: "2026-09-17",
          source: "State Street official 30 Day SEC Yield",
          kind: "30_day_sec_yield",
          yield_type: "30 Day SEC Yield",
          status: "valid",
        },
      },
    },
  };
  const row = parseSnapshot(qndxSnapshot, "QNDX", "DIVIDEND_RATE");
  assert.equal(row.rate, 0.0044);
  assert.equal(row.yield_type, "30 Day SEC Yield");
  assert.equal(row._status, "valid");
});
