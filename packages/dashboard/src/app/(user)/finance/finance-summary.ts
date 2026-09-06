/**
 * Pure period summary over decrypted ledger rows (computed server-side in
 * finance-server-actions.ts, unit-tested here). Amounts are the tool's
 * absolute values with `kind` carrying the sign: charges add, refunds
 * subtract. Only the primary currency feeds the bars; other currencies are
 * tallied separately so a EUR account never mixes into ILS totals.
 */
import {
  PRIMARY_CURRENCY,
  rowCategoryMain,
  rowMerchant,
  type BarRow,
  type LedgerRow,
  type LedgerSummary,
} from "./finance-types";

const round2 = (n: number): number => Math.round(n * 100) / 100;

function signedAmount(row: LedgerRow): number | null {
  if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) return null;
  if (row.kind === "refund") return -Math.abs(row.amount);
  if (row.kind === "charge") return Math.abs(row.amount);
  return null; // bills / appointments / notices carry no spend
}

function bump(map: Map<string, BarRow>, label: string, amount: number): void {
  const cur = map.get(label) ?? { label, total: 0, count: 0 };
  cur.total = round2(cur.total + amount);
  cur.count += 1;
  map.set(label, cur);
}

function sorted(map: Map<string, BarRow>, limit?: number): BarRow[] {
  const rows = [...map.values()].sort((a, b) => b.total - a.total || b.count - a.count || a.label.localeCompare(b.label));
  return limit ? rows.slice(0, limit) : rows;
}

export function summarizeLedgerRows(rows: LedgerRow[], partial = false): LedgerSummary {
  let charges = 0;
  let refunds = 0;
  let count = 0;
  const other: Record<string, number> = {};
  const merchants = new Map<string, BarRow>();
  const categories = new Map<string, BarRow>();
  const accounts = new Map<string, BarRow>();

  for (const row of rows) {
    const signed = signedAmount(row);
    if (signed === null) continue;
    count += 1;
    const currency = (row.currency ?? PRIMARY_CURRENCY).toUpperCase();
    if (currency !== PRIMARY_CURRENCY) {
      other[currency] = round2((other[currency] ?? 0) + signed);
      continue;
    }
    if (signed >= 0) charges = round2(charges + signed);
    else refunds = round2(refunds + -signed);
    bump(merchants, rowMerchant(row) ?? "(no merchant)", signed);
    bump(categories, rowCategoryMain(row) ?? "Uncategorized", signed);
    bump(accounts, row.account_ref ? `····${row.account_ref.slice(-4)}` : "(no account)", signed);
  }

  return {
    currency: PRIMARY_CURRENCY,
    charges,
    refunds,
    count,
    other_currencies: other,
    top_merchants: sorted(merchants, 10),
    by_category: sorted(categories),
    by_account: sorted(accounts),
    rows_considered: rows.length,
    partial,
  };
}
