import { describe, it, expect } from "vitest";
import { summarizeLedgerRows } from "./finance-summary";
import { rowCategoryMain, rowMerchant, type LedgerRow } from "./finance-types";

function row(p: Partial<LedgerRow> & { payload?: Record<string, unknown> | null }): LedgerRow {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    connector_id: "financy",
    account_ref: p.account_ref === undefined ? "0034" : p.account_ref,
    external_id: p.external_id ?? "x",
    kind: p.kind ?? "charge",
    occurred_at: "2026-09-01T00:00:00.000Z",
    posted_at: null,
    amount: p.amount ?? 0,
    currency: p.currency === undefined ? "ILS" : p.currency,
    merchant_key: null,
    payload: p.payload === undefined ? { merchant: "Shufersal", category: { main: "Groceries", sub: "Supermarket" } } : p.payload,
    fetched_at: "2026-09-02T00:00:00.000Z",
  };
}

describe("summarizeLedgerRows", () => {
  it("totals charges and refunds separately and nets merchants, categories and accounts", () => {
    const s = summarizeLedgerRows([
      row({ amount: 100 }),
      row({ amount: 50.25 }),
      row({ amount: 20, kind: "refund" }),
      row({ amount: 300, account_ref: "0026", payload: { merchant: "רמי לוי", category: { main: "Groceries" } } }),
      row({ amount: 80, account_ref: "0026", payload: { merchant: "Paz", category: { main: "Fuel" } } }),
    ]);
    expect(s.charges).toBe(530.25);
    expect(s.refunds).toBe(20);
    expect(s.count).toBe(5);
    expect(s.top_merchants[0]).toEqual({ label: "רמי לוי", total: 300, count: 1 });
    expect(s.top_merchants.find((m) => m.label === "Shufersal")).toEqual({ label: "Shufersal", total: 130.25, count: 3 });
    expect(s.by_category.map((c) => c.label)).toEqual(["Groceries", "Fuel"]);
    expect(s.by_category[0].total).toBe(430.25);
    expect(s.by_account).toEqual([
      { label: "····0026", total: 380, count: 2 },
      { label: "····0034", total: 130.25, count: 3 },
    ]);
    expect(s.partial).toBe(false);
    expect(s.rows_considered).toBe(5);
  });

  it("keeps other currencies out of the ILS bars and ignores non-money kinds", () => {
    const s = summarizeLedgerRows([
      row({ amount: 10, currency: "EUR" }),
      row({ amount: 4, currency: "EUR", kind: "refund" }),
      row({ amount: 999, kind: "bill" }),
      row({ amount: 5, currency: null }),
    ], true);
    expect(s.charges).toBe(5);
    expect(s.other_currencies).toEqual({ EUR: 6 });
    expect(s.count).toBe(3);
    expect(s.partial).toBe(true);
  });

  it("caps merchants at 10 and labels missing merchant / category / account", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ amount: i + 1, payload: { merchant: `M${i}` } }));
    rows.push(row({ amount: 1, account_ref: null, payload: null }));
    const s = summarizeLedgerRows(rows);
    expect(s.top_merchants).toHaveLength(10);
    expect(s.top_merchants[0].label).toBe("M11");
    expect(s.by_category).toEqual([{ label: "Uncategorized", total: 79, count: 13 }]);
    expect(s.by_account.map((a) => a.label)).toEqual(["····0034", "(no account)"]);
  });
});

describe("payload accessors", () => {
  it("read category.main from the structured, extra-nested or flat shapes", () => {
    expect(rowCategoryMain(row({ payload: { category: { main: "A", sub: "B" } } }))).toBe("A");
    expect(rowCategoryMain(row({ payload: { extra: { category: { main: "C" } } } }))).toBe("C");
    expect(rowCategoryMain(row({ payload: { category: "Flat" } }))).toBe("Flat");
    expect(rowCategoryMain(row({ payload: { category: { main: "" } } }))).toBeNull();
    expect(rowCategoryMain(row({ payload: null }))).toBeNull();
  });

  it("reads the merchant only from the payload", () => {
    expect(rowMerchant(row({ payload: { merchant: "  Wolt " } }))).toBe("Wolt");
    expect(rowMerchant(row({ payload: { merchant: 3 } }))).toBeNull();
  });
});
