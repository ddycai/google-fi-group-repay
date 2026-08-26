import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findMemberTable,
  findStatementDate,
  parseAmountCents,
  parseStatementText,
  toMonthLabel,
} from "../src/parse.js";
import { PAGE_2, PAGES } from "./fixtures/statement-pages.js";

test("parses a whole statement", () => {
  const parsed = parseStatementText(PAGES);
  assert.equal(parsed.statementDate, "Aug 17, 2026");
  assert.equal(parsed.month, "August 2026");
  assert.equal(parsed.total, 180.20);
  assert.deepEqual(parsed.people, {
    "Ada Byron": 34.60,
    "Grace Murray": 61.25,
    "Sample Owner": 18.35,
    "Alan Turing": 66.0,
  });
});

test("keeps the statement's own ordering", () => {
  assert.deepEqual(Object.keys(parseStatementText(PAGES).people), [
    "Ada Byron",
    "Grace Murray",
    "Sample Owner",
    "Alan Turing",
  ]);
});

test("amount cells parse, including parenthesised credits", () => {
  assert.equal(parseAmountCents("$34.60"), 3460);
  assert.equal(parseAmountCents("  $1,234.56 "), 123456);
  assert.equal(parseAmountCents("($12.75)"), -1275);
});

test("a line that merely contains an amount is not an amount cell", () => {
  // This is the summary row directly above the table; treating it as a cell
  // would let the backwards walk run off the top of the table.
  assert.equal(parseAmountCents("Total $180.20"), null);
  assert.equal(parseAmountCents("Device payment $21.40"), null);
  assert.equal(parseAmountCents("$12.75)"), null);
  assert.equal(parseAmountCents("($12.75"), null);
  assert.equal(parseAmountCents("$32.8"), null);
  assert.equal(parseAmountCents(""), null);
});

test("the walk stops at the summary row above the table", () => {
  const { people } = findMemberTable([PAGE_2]);
  assert.equal(Object.keys(people).length, 4);
  assert.equal("Total" in people, false);
  assert.equal("Service Credit" in people, false);
  assert.equal("Device payment" in people, false);
});

test("statement dates become month labels", () => {
  assert.equal(toMonthLabel("Aug 17, 2026"), "August 2026");
  assert.equal(toMonthLabel("Dec 1, 2025"), "December 2025");
  assert.throws(() => toMonthLabel("17 August 2026"), /Unrecognised statement date/);
  assert.throws(() => toMonthLabel("Foo 17, 2026"), /Unrecognised/);
});

test("a table whose parts disagree with its total is rejected, not guessed at", () => {
  const corrupted = PAGE_2.replace("Ada Byron\n$34.60", "Ada Byron\n$44.60");
  assert.throws(() => findMemberTable([corrupted]), /misread — refusing to guess/);
});

test("a PDF with no member table fails loudly", () => {
  assert.throws(
    () => findMemberTable(["Statement\nAug 17, 2026\nNothing useful here"]),
    /No per-member table found/,
  );
});

test("a single name/amount pair is not treated as a table", () => {
  // Guards against latching onto some unrelated trailing "Total" block.
  assert.throws(
    () => findMemberTable(["Preamble\nOnly One\n$10.00\nTotal\n$10.00"]),
    /No per-member table found/,
  );
});

test("a non-Fi PDF fails on the date rather than half-parsing", () => {
  assert.throws(() => findStatementDate(["Some other bill entirely"]), /Is this a Google Fi statement/);
});
