import type { Bill, Config, Share } from "./types.js";

/** Dollars to whole cents. Everything downstream is integer cents. */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) {
    throw new Error(`Not a number: ${dollars}`);
  }
  return Math.round(dollars * 100);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Match the statement's per-member amounts up to the configured people.
 *
 * Google Fi has already done the arithmetic — taxes, fees, device payments and
 * credits are allocated per person on page 2 of the PDF — so there is nothing
 * to divide here. This is validation: every name accounted for, and the parts
 * still summing to the total we were told.
 */
export function computeShares(bill: Bill, config: Config): Share[] {
  const owners = config.people.filter((p) => p.isOwner);
  if (owners.length !== 1) {
    throw new Error(
      `Config needs exactly one person with "isOwner": true, found ${owners.length}.`,
    );
  }

  const unknown = Object.keys(bill.people).filter(
    (name) => !config.people.some((p) => p.name === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Statement lists people missing from config: ${unknown.join(", ")}. ` +
        `Names must match the statement exactly.`,
    );
  }

  const missing = config.people.filter((p) => !(p.name in bill.people));
  if (missing.length > 0) {
    throw new Error(
      `Config has people with no amount on this statement: ${missing.map((p) => p.name).join(", ")}`,
    );
  }

  const shares: Share[] = config.people.map((person) => ({
    name: person.name,
    venmo: person.venmo,
    isOwner: person.isOwner === true,
    totalCents: toCents(bill.people[person.name] ?? 0),
  }));

  if (bill.total !== undefined) {
    const expected = toCents(bill.total);
    const actual = shares.reduce((sum, s) => sum + s.totalCents, 0);
    if (expected !== actual) {
      throw new Error(
        `Per-person amounts sum to ${formatCents(actual)} but the statement total is ` +
          `${formatCents(expected)} (off by ${formatCents(actual - expected)}). ` +
          `Something was misread from the PDF.`,
      );
    }
  }

  return shares;
}

/** Everyone who should get a charge link — i.e. everyone but the owner. */
export function chargeable(shares: Share[]): Share[] {
  return shares.filter((s) => !s.isOwner && s.totalCents > 0);
}
