import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSubject, describeChange, diffAmounts } from "../src/changes.js";

const august = { "Ada Byron": 34.60, "Grace Murray": 61.25, "Alan Turing": 18.35 };

test("an identical month reports nothing", () => {
  assert.deepEqual(diffAmounts(august, { ...august }), []);
});

test("no previous statement is not a change", () => {
  // First run: everything is 'new', but reporting three changes would be noise.
  assert.deepEqual(diffAmounts(undefined, august), []);
});

test("a changed amount is reported with both values", () => {
  const changes = diffAmounts(august, { ...august, "Grace Murray": 34.60 });
  assert.deepEqual(changes, [{ name: "Grace Murray", from: 61.25, to: 34.60 }]);
});

test("people joining and leaving are reported", () => {
  const { "Alan Turing": _gone, ...rest } = august;
  const changes = diffAmounts(august, { ...rest, "Ada Lovelace": 20.0 });
  assert.deepEqual(changes.sort((a, b) => a.name.localeCompare(b.name)), [
    { name: "Ada Lovelace", from: null, to: 20.0 },
    { name: "Alan Turing", from: 18.35, to: null },
  ]);
});

test("float noise is not mistaken for a change", () => {
  assert.deepEqual(diffAmounts({ "Ada Byron": 0.1 + 0.2 }, { "Ada Byron": 0.3 }), []);
});

test("changes read as plain sentences", () => {
  assert.equal(
    describeChange({ name: "Grace Murray", from: 61.25, to: 34.60 }),
    "Grace Murray down $26.65 — $61.25 → $34.60",
  );
  assert.equal(
    describeChange({ name: "Ada Byron", from: 34.60, to: 40.0 }),
    "Ada Byron up $5.40 — $34.60 → $40.00",
  );
  assert.equal(
    describeChange({ name: "Ada Lovelace", from: null, to: 20.0 }),
    "Ada Lovelace added at $20.00",
  );
  assert.equal(
    describeChange({ name: "Alan Turing", from: 18.35, to: null }),
    "Alan Turing dropped off (was $18.35)",
  );
});

test("the subject line says whether anything moved", () => {
  assert.equal(buildSubject("August 2026", 180.20, [], false), "Google Fi August 2026 — $180.20");
  assert.equal(
    buildSubject("August 2026", 180.20, [], true),
    "Google Fi August 2026 — $180.20 — first run",
  );
  assert.equal(
    buildSubject("August 2026", 180.20, [{ name: "A", from: 1, to: 2 }], false),
    "Google Fi August 2026 — $180.20 — 1 amount changed",
  );
  assert.equal(
    buildSubject(
      "August 2026",
      180.20,
      [
        { name: "A", from: 1, to: 2 },
        { name: "B", from: 3, to: 4 },
      ],
      false,
    ),
    "Google Fi August 2026 — $180.20 — 2 amounts changed",
  );
});
