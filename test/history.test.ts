import assert from "node:assert/strict";
import { test } from "node:test";
import { type StatementRecord, updateHistory } from "../src/history.js";

const aug: StatementRecord = {
  statementDate: "Aug 17, 2026",
  people: { Ada: 34.60, Grace: 61.25 },
  total: 95.85,
};
const jul: StatementRecord = {
  statementDate: "Jul 17, 2026",
  people: { Ada: 34.60, Grace: 61.25 },
  total: 95.85,
};

test("the first statement has no baseline and is stored", () => {
  const { baseline, isRepeat, next } = updateHistory(undefined, aug);
  assert.equal(baseline, undefined);
  assert.equal(isRepeat, false);
  assert.deepEqual(next, [aug]);
});

test("a new statement compares against the previous one", () => {
  const { baseline, isRepeat, next } = updateHistory([jul], aug);
  assert.deepEqual(baseline, jul);
  assert.equal(isRepeat, false);
  assert.deepEqual(next, [aug, jul]);
});

test("a duplicate does not overwrite the baseline", () => {
  // The failure this guards: storing the repeat would leave August comparing
  // against August, so a real change next month would read as no change.
  const { baseline, isRepeat, next } = updateHistory([aug, jul], aug);
  assert.equal(isRepeat, true);
  assert.deepEqual(baseline, jul, "must still compare against July");
  assert.deepEqual(next, [aug, jul], "history must be untouched");
});

test("only this month and last are kept", () => {
  const jun: StatementRecord = { ...jul, statementDate: "Jun 17, 2026" };
  const { next } = updateHistory([jul, jun], aug);
  assert.deepEqual(
    next.map((r) => r.statementDate),
    ["Aug 17, 2026", "Jul 17, 2026"],
  );
});

test("a repeat still has last month to compare against", () => {
  // The reason two are kept rather than one: with a single slot the repeat
  // would find only itself, and report no changes even when there were some.
  const { baseline } = updateHistory([aug, jul], aug);
  assert.deepEqual(baseline, jul);
});
