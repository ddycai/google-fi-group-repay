import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCharges, chargeLink, groupCharges, listNames, truncateNote } from "../src/links.js";
import { chargeable, computeShares, formatCents, toCents } from "../src/split.js";
import type { Bill, Config } from "../src/types.js";

const config: Config = {
  people: [
    { name: "Sample Owner", isOwner: true },
    { name: "Ada Byron", venmo: "ada-example" },
    { name: "Alan Turing", venmo: "alan-example" },
    { name: "Grace Murray", venmo: "grace-example" },
    { name: "Rosalind Franklin", venmo: "rosalind-example" },
  ],
  noteTemplate: "Google Fi — {month}",
};

// Shaped like a real statement's page 2; the amounts are synthetic.
const bill: Bill = {
  month: "August 2026",
  people: {
    "Sample Owner": 61.25,
    "Ada Byron": 34.60,
    "Alan Turing": 18.35,
    "Grace Murray": 34.60,
    "Rosalind Franklin": 34.60,
  },
  total: 183.40,
};

test("toCents rounds float noise to whole cents", () => {
  assert.equal(toCents(34.60), 3460);
  assert.equal(toCents(18.35), 1835);
  assert.equal(toCents(0.1 + 0.2), 30);
});

test("shares come straight off the statement", () => {
  const shares = computeShares(bill, config);
  assert.deepEqual(
    shares.map((s) => [s.name, s.totalCents]),
    [
      ["Sample Owner", 6125],
      ["Ada Byron", 3460],
      ["Alan Turing", 1835],
      ["Grace Murray", 3460],
      ["Rosalind Franklin", 3460],
    ],
  );
});

test("shares sum to the statement total", () => {
  const shares = computeShares(bill, config);
  assert.equal(
    shares.reduce((sum, s) => sum + s.totalCents, 0),
    toCents(bill.total!),
  );
});

test("a total that disagrees with the per-person amounts is rejected", () => {
  assert.throws(
    () => computeShares({ ...bill, total: 190.0 }, config),
    /sum to \$183\.40 but the statement total is \$190\.00/,
  );
});

test("a person on the statement but missing from config is rejected", () => {
  assert.throws(
    () => computeShares({ ...bill, people: { ...bill.people, "Sam Newman": 25 } }, config),
    /missing from config: Sam Newman/,
  );
});

test("a person in config with no amount on the statement is rejected", () => {
  const { "Alan Turing": _dropped, ...rest } = bill.people;
  assert.throws(
    () => computeShares({ ...bill, people: rest, total: 165.05 }, config),
    /no amount on this statement: Alan Turing/,
  );
});

test("config must name exactly one owner", () => {
  assert.throws(
    () => computeShares(bill, { ...config, people: config.people.map((p) => ({ ...p, isOwner: true })) }),
    /exactly one person/,
  );
});

test("the owner is not charged", () => {
  const rows = chargeable(computeShares(bill, config));
  assert.deepEqual(rows.map((s) => s.name), [
    "Ada Byron",
    "Alan Turing",
    "Grace Murray",
    "Rosalind Franklin",
  ]);
});

test("someone owing nothing gets no link", () => {
  const shares = computeShares(
    { ...bill, people: { ...bill.people, "Grace Murray": 0 }, total: 148.80 },
    config,
  );
  assert.equal(chargeable(shares).some((s) => s.name === "Grace Murray"), false);
});

test("a missing venmo handle fails loudly rather than silently skipping", () => {
  const shares = chargeable(
    computeShares(bill, {
      ...config,
      people: config.people.map((p) => (p.name === "Ada Byron" ? { name: p.name } : p)),
    }),
  );
  assert.throws(() => buildCharges(shares, config.noteTemplate, bill.month), /Ada Byron/);
});

test("people owing the same amount collapse into one link", () => {
  const rows = buildCharges(chargeable(computeShares(bill, config)), config.noteTemplate, bill.month);
  const groups = groupCharges(rows);

  assert.equal(groups.length, 2, "three at $34.60, one alone at $18.35");

  const [big, small] = groups;
  assert.deepEqual(big!.members.map((m) => m.share.name), [
    "Ada Byron",
    "Grace Murray",
    "Rosalind Franklin",
  ]);
  assert.equal(
    big!.link,
    "https://venmo.com/payment-link" +
      "?txn=charge&amount=34.60&note=Google%20Fi%20%E2%80%94%20August%202026" +
      "&recipients=ada-example,grace-example,rosalind-example",
  );
  assert.deepEqual(small!.members.map((m) => m.share.name), ["Alan Turing"]);
  assert.equal(small!.amount, "18.35");
});

test("the comma separating usernames is not encoded away", () => {
  // %2C would make Venmo read the whole thing as one username.
  const link = chargeLink(["ada", "grace"], 1000, "x");
  assert.match(link, /recipients=ada,grace$/);
  assert.doesNotMatch(link, /%2C/);
});

test("group links use payment-link, not the path form that 404s", () => {
  // venmo.com/a,b,c is "this page isn't available" to any server that is asked.
  const link = chargeLink(["ada", "grace", "rosalind"], 3460, "x");
  assert.match(link, /^https:\/\/venmo\.com\/payment-link\?/);
  assert.doesNotMatch(link, /venmo\.com\/ada/);
});

test("one link form serves both the app and a browser", () => {
  // venmo.com is Venmo's universal-link domain, so a phone hands this to the
  // app; anywhere else it 302s to account.venmo.com and renders as a page.
  const link = chargeLink(["ada", "grace"], 3460, "x");
  assert.match(link, /^https:\/\/venmo\.com\/payment-link\?/);
  assert.match(link, /recipients=ada,grace$/);
});

test("the link is never account.venmo.com, which skips the app handoff", () => {
  assert.doesNotMatch(chargeLink(["ada"], 3460, "x"), /account\.venmo\.com/);
});

test("recipients go in the query, never the path", () => {
  // venmo.com/a,b,c 404s once a server is actually asked.
  assert.doesNotMatch(chargeLink(["ada", "grace"], 3460, "x"), /venmo\.com\/ada/);
});

test("an all-equal month collapses to a single tap", () => {
  const equal = { ...bill, people: { ...bill.people, "Alan Turing": 34.60 }, total: 199.65 };
  const rows = buildCharges(chargeable(computeShares(equal, config)), config.noteTemplate, equal.month);
  const groups = groupCharges(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.members.length, 4);
});

test("groups are ordered biggest first", () => {
  const rows = buildCharges(chargeable(computeShares(bill, config)), config.noteTemplate, bill.month);
  const sizes = groupCharges(rows).map((g) => g.members.length);
  assert.deepEqual(sizes, [3, 1]);
});

test("names read as a sentence", () => {
  assert.equal(listNames([]), "");
  assert.equal(listNames(["Ada"]), "Ada");
  assert.equal(listNames(["Ada", "Grace"]), "Ada and Grace");
  assert.equal(listNames(["Ada", "Grace", "Alan"]), "Ada, Grace and Alan");
});

test("a multi-recipient link rejects an empty username", () => {
  assert.throws(() => chargeLink(["ada", ""], 1000, "x"), /username is empty/);
  assert.throws(() => chargeLink([], 1000, "x"), /No Venmo usernames/);
});

test("charge links encode the note and strip a leading @", () => {
  assert.equal(
    chargeLink("@ada-example", 3460, "Google Fi — August 2026"),
    "https://venmo.com/payment-link" +
      "?txn=charge&amount=34.60&note=Google%20Fi%20%E2%80%94%20August%202026&recipients=ada-example",
  );
});

test("charge links reject a non-positive amount", () => {
  assert.throws(() => chargeLink("bryan", 0, "nope"), /must be positive/);
});

test("long notes are truncated", () => {
  assert.equal(truncateNote("a".repeat(500)).length, 200);
  assert.equal(truncateNote("short"), "short");
});

test("formatCents pads the decimal", () => {
  assert.equal(formatCents(6125), "$61.25");
  assert.equal(formatCents(400), "$4.00");
  assert.equal(formatCents(5), "$0.05");
});

test("group links are always the payment-link form", () => {
  const rows = buildCharges(chargeable(computeShares(bill, config)), config.noteTemplate, bill.month);
  // The app form cannot carry a comma list, so a group has no other option.
  assert.match(groupCharges(rows)[0]!.link, /^https:\/\/venmo\.com\/payment-link\?/);
});

test("no link is ever a venmo:// deeplink", () => {
  // Gmail strips the href from any scheme outside http/https/mailto/ftp.
  const rows = buildCharges(chargeable(computeShares(bill, config)), config.noteTemplate, bill.month);
  for (const row of rows) {
    assert.match(row.link, /^https:\/\//, `${row.username}: ${row.link}`);
  }
  assert.match(groupCharges(rows)[0]!.link, /^https:\/\//);
});
