import { extractText, getDocumentProxy } from "unpdf";
import type { Bill } from "./types.js";

export interface ParsedStatement extends Bill {
  /** As printed on the statement, e.g. "Aug 17, 2026". */
  statementDate: string;
}

const MONTHS: Record<string, string> = {
  Jan: "January",
  Feb: "February",
  Mar: "March",
  Apr: "April",
  May: "May",
  Jun: "June",
  Jul: "July",
  Aug: "August",
  Sep: "September",
  Oct: "October",
  Nov: "November",
  Dec: "December",
};

/**
 * A standalone currency cell, e.g. "$34.60" or "($12.75)".
 *
 * Anchored, so a line that merely contains an amount ("Total $180.20", the
 * summary row that sits directly above the per-member table) does not match.
 * The table walk relies on that to know where to stop.
 */
const AMOUNT_LINE = /^(\()?\$([\d,]+\.\d{2})(\))?$/;

export function parseAmountCents(line: string): number | null {
  const match = AMOUNT_LINE.exec(line.trim());
  if (!match) return null;

  const [, open, digits, close] = match;
  // "($12.75" or "$12.75)" is malformed, not a negative.
  if (Boolean(open) !== Boolean(close)) return null;

  const cents = Math.round(Number(digits!.replace(/,/g, "")) * 100);
  return open ? -cents : cents;
}

export function toMonthLabel(statementDate: string): string {
  const match = /^([A-Z][a-z]{2})\s+\d{1,2},\s*(\d{4})$/.exec(statementDate.trim());
  if (!match) throw new Error(`Unrecognised statement date: "${statementDate}"`);

  const month = MONTHS[match[1]!];
  if (!month) throw new Error(`Unrecognised month in statement date: "${statementDate}"`);
  return `${month} ${match[2]}`;
}

export function findStatementDate(pages: string[]): string {
  for (const page of pages) {
    const match = /monthly statement for\s+([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})/.exec(page);
    if (match) return match[1]!.replace(/\s+/g, " ");
  }
  throw new Error(
    `No "monthly statement for <date>" line found. Is this a Google Fi statement?`,
  );
}

interface MemberTable {
  people: Record<string, number>;
  totalCents: number;
}

/**
 * Read the per-member table off whichever page carries it.
 *
 * The table is the last thing on its page and ends with a bare "Total" / amount
 * pair, so we anchor on that and walk backwards in name/amount pairs. Walking
 * backwards rather than forwards means we never have to recognise where the
 * table *starts* — the summary rows above it simply fail to match and stop us.
 */
export function findMemberTable(pages: string[]): MemberTable {
  for (const page of pages) {
    const table = readMemberTable(page);
    if (table) return table;
  }
  throw new Error(
    "No per-member table found. It is normally the last block on page 2, " +
      "ending with a bare 'Total' line followed by the amount.",
  );
}

function readMemberTable(page: string): MemberTable | null {
  const lines = page
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const last = lines.length - 1;
  const totalCents = parseAmountCents(lines[last] ?? "");
  if (totalCents === null || lines[last - 1] !== "Total") return null;

  const entries: Array<[string, number]> = [];
  for (let i = last - 2; i >= 1; i -= 2) {
    const cents = parseAmountCents(lines[i]!);
    if (cents === null) break;

    const name = lines[i - 1]!;
    if (name === "Total" || parseAmountCents(name) !== null) break;

    entries.push([name, cents]);
  }

  if (entries.length < 2) return null;
  entries.reverse();

  const summed = entries.reduce((sum, [, cents]) => sum + cents, 0);
  if (summed !== totalCents) {
    throw new Error(
      `Per-member amounts sum to ${(summed / 100).toFixed(2)} but the table total is ` +
        `${(totalCents / 100).toFixed(2)}. The PDF was misread — refusing to guess.`,
    );
  }

  return {
    people: Object.fromEntries(entries.map(([name, cents]) => [name, cents / 100])),
    totalCents,
  };
}

export function parseStatementText(pages: string[]): ParsedStatement {
  const statementDate = findStatementDate(pages);
  const { people, totalCents } = findMemberTable(pages);

  return {
    statementDate,
    month: toMonthLabel(statementDate),
    people,
    total: totalCents / 100,
  };
}

export async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

export async function parseStatementPdf(bytes: Uint8Array): Promise<ParsedStatement> {
  return parseStatementText(await extractPdfPages(bytes));
}
