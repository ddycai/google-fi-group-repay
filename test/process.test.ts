import assert from "node:assert/strict";
import { test } from "node:test";
import type { StatementRecord } from "../src/history.js";
import { parseStatementText } from "../src/parse.js";
import {
  addressOf,
  findPdf,
  type OutgoingMail,
  type ProcessDeps,
  processStatement,
} from "../src/process.js";
import type { Config } from "../src/types.js";
import { PAGES } from "./fixtures/statement-pages.js";

const config: Config = {
  people: [
    { name: "Sample Owner", isOwner: true },
    { name: "Ada Byron", venmo: "ada" },
    { name: "Grace Murray", venmo: "grace" },
    { name: "Alan Turing", venmo: "alan" },
  ],
  noteTemplate: "Google Fi — {month}",
};

const statementMail = {
  from: "Google Payments <payments-noreply@google.com>",
  subject: "Your Google Fi monthly statement",
  attachments: [
    {
      name: "Google Fi-2026-08-18.pdf",
      type: "application/pdf",
      bytes: async () => new Uint8Array(),
    },
  ],
};

interface Harness {
  deps: ProcessDeps;
  sent: OutgoingMail[];
  saved: StatementRecord[][];
}

/** `html` is optional on OutgoingMail; a statement email must always have one. */
function htmlOf(mail: OutgoingMail | undefined): string {
  assert.ok(mail?.html, "expected mail with an html body");
  return mail.html;
}

function harness(history?: StatementRecord[], overrides: Partial<ProcessDeps> = {}): Harness {
  const sent: OutgoingMail[] = [];
  const saved: StatementRecord[][] = [];
  return {
    sent,
    saved,
    deps: {
      config,
      allowedSenders: ["payments-noreply@google.com"],
      // unpdf itself is verified separately against a real statement; here the
      // extracted page text stands in so the orchestration can be exercised.
      parsePdf: async () => parseStatementText(PAGES),
      getHistory: async () => history,
      saveHistory: async (next) => void saved.push(next),
      send: async (mail) => void sent.push(mail),
      ...overrides,
    },
  };
}

test("a statement produces one email with a link per non-owner", async () => {
  const h = harness();
  const result = await processStatement(statementMail, h.deps);

  assert.deepEqual(result, {
    status: "sent",
    month: "August 2026",
    charged: 3,
    isRepeat: false,
  });
  assert.equal(h.sent.length, 1);

  const { text, subject } = h.sent[0]!;
  const html = htmlOf(h.sent[0]);
  assert.equal(subject, "Google Fi August 2026 — $180.20 — first run");
  for (const handle of ["ada", "grace", "alan"]) {
    // August's amounts are all distinct, so every card is one person.
    assert.match(html, new RegExp(`https://venmo\\.com/${handle}\\?txn=charge`));
    assert.match(text, new RegExp(`https://venmo\\.com/${handle}\\?txn=charge`));
  }
});

test("the owner is never charged", async () => {
  const h = harness();
  await processStatement(statementMail, h.deps);
  assert.doesNotMatch(htmlOf(h.sent[0]), /Sample Owner/);
});

test("the statement is recorded for next month's comparison", async () => {
  const h = harness();
  await processStatement(statementMail, h.deps);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0]![0]!.statementDate, "Aug 17, 2026");
});

test("an unchanged month says nothing about changes", async () => {
  const july: StatementRecord = {
    statementDate: "Jul 17, 2026",
    people: { "Ada Byron": 34.60, "Grace Murray": 61.25, "Sample Owner": 18.35, "Alan Turing": 66.0 },
    total: 180.20,
  };
  const h = harness([july]);
  await processStatement(statementMail, h.deps);
  assert.equal(h.sent[0]!.subject, "Google Fi August 2026 — $180.20");
  assert.doesNotMatch(htmlOf(h.sent[0]), /changed since last month/);
});

test("a changed amount is called out in the subject and the body", async () => {
  const july: StatementRecord = {
    statementDate: "Jul 17, 2026",
    people: { "Ada Byron": 34.60, "Grace Murray": 86.20, "Sample Owner": 18.35, "Alan Turing": 66.0 },
    total: 205.15,
  };
  const h = harness([july]);
  await processStatement(statementMail, h.deps);

  assert.equal(h.sent[0]!.subject, "Google Fi August 2026 — $180.20 — 1 amount changed");
  assert.match(htmlOf(h.sent[0]), /Grace Murray down \$24\.95/);
});

test("a repeat is labelled and does not overwrite the baseline", async () => {
  const august: StatementRecord = {
    statementDate: "Aug 17, 2026",
    people: { "Ada Byron": 34.60, "Grace Murray": 61.25, "Sample Owner": 18.35, "Alan Turing": 66.0 },
    total: 180.20,
  };
  const h = harness([august]);
  const result = await processStatement(statementMail, h.deps);

  assert.equal(result.status === "sent" && result.isRepeat, true);
  assert.match(h.sent[0]!.subject, /\(repeat\)$/);
  assert.equal(h.saved.length, 0, "history must not be rewritten");
});

test("mail from anyone but Fi is ignored without parsing", async () => {
  let parsed = false;
  const h = harness(undefined, {
    parsePdf: async () => {
      parsed = true;
      return parseStatementText(PAGES);
    },
  });

  const result = await processStatement(
    { ...statementMail, from: "Someone Else <attacker@example.com>" },
    h.deps,
  );

  assert.equal(result.status, "ignored");
  assert.equal(parsed, false, "an untrusted PDF must not be parsed");
  assert.equal(h.sent.length, 0);
});

test("history is not saved when sending fails", async () => {
  const h = harness(undefined, {
    send: async () => {
      throw new Error("mail server down");
    },
  });
  await assert.rejects(() => processStatement(statementMail, h.deps), /mail server down/);
  assert.equal(h.saved.length, 0, "a failed send must not consume the month");
});

test("a statement naming someone unknown is rejected rather than part-charged", async () => {
  const h = harness(undefined, {
    config: { ...config, people: config.people.filter((p) => p.name !== "Alan Turing") },
  });
  await assert.rejects(
    () => processStatement(statementMail, h.deps),
    /missing from config: Alan Turing/,
  );
  assert.equal(h.sent.length, 0);
});

test("a Gmail forwarding confirmation is relayed so setup can complete", async () => {
  let parsed = false;
  const h = harness(undefined, {
    parsePdf: async () => {
      parsed = true;
      return parseStatementText(PAGES);
    },
  });

  const result = await processStatement(
    {
      from: "Gmail Team <forwarding-noreply@google.com>",
      subject: "Google Forwarding Confirmation",
      text: "Confirmation code: 123456789",
      attachments: [],
    },
    h.deps,
  );

  assert.equal(result.status, "confirmation");
  assert.equal(parsed, false, "the confirmation must not be parsed as a statement");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.text, /123456789/);
  assert.equal(h.saved.length, 0);

  // Val Town rejects an empty html body, so it must be absent, not "".
  assert.equal(h.sent[0]!.html, undefined);
});

test("no mail is ever sent with an empty html body", async () => {
  const h = harness();
  await processStatement(statementMail, h.deps);
  await processStatement(
    {
      from: "Gmail Team <forwarding-noreply@google.com>",
      text: "Confirmation code: 1",
      attachments: [],
    },
    h.deps,
  );

  assert.equal(h.sent.length, 2);
  for (const mail of h.sent) {
    assert.notEqual(mail.html, "", `"${mail.subject}" would be rejected by Val Town`);
    assert.ok(mail.text.length > 0);
  }
});

test("addresses are extracted from display-name form", () => {
  assert.equal(addressOf("Google Payments <payments-noreply@google.com>"), "payments-noreply@google.com");
  assert.equal(addressOf("  PAYMENTS-NOREPLY@GOOGLE.COM "), "payments-noreply@google.com");
});

test("the PDF attachment is found by type or extension", () => {
  assert.equal(findPdf([{ name: "s.pdf", type: "" }]).name, "s.pdf");
  assert.equal(findPdf([{ name: "s", type: "application/pdf" }]).name, "s");
  assert.throws(() => findPdf([{ name: "a.txt", type: "text/plain" }]), /No PDF attachment/);
  assert.throws(
    () => findPdf([{ name: "a.pdf", type: "" }, { name: "b.pdf", type: "" }]),
    /found 2/,
  );
});

/** The href of the big blue button, as opposed to the muted secondary links. */
function buttonHref(html: string): string {
  const m = html.match(/<a href="([^"]+)" style="display:block;padding:14px/);
  assert.ok(m, "expected a primary button in the email");
  return m[1]!.replace(/&amp;/g, "&");
}

test("single-person cards use venmo.com/<user>, never payment-link", async () => {
  const h = harness();
  await processStatement(statementMail, h.deps);
  const html = htmlOf(h.sent[0]);

  // venmo.com/payment-link loops between browser and app on a phone.
  assert.doesNotMatch(html, /\/\/venmo\.com\/payment-link/);
  assert.doesNotMatch(h.sent[0]!.text, /\/\/venmo\.com\/payment-link/);
  assert.doesNotMatch(html, /venmo:\/\//, "Gmail strips non-https schemes");
  // August has no shared amounts, so nothing should need the browser form.
  assert.doesNotMatch(html, /account\.venmo\.com/);
});

test("a group offers the same charge one person at a time", async () => {
  const h = harness(undefined, {
    parsePdf: async () => {
      const { parseStatementText } = await import("../src/parse.js");
      const { PAGES } = await import("./fixtures/statement-pages.js");
      const parsed = parseStatementText(PAGES);
      // Alan drops to Ada's amount so the two collapse into one card; the
      // total has to follow or split.ts rejects the statement.
      const ada = parsed.people["Ada Byron"]!;
      const delta = parsed.people["Alan Turing"]! - ada;
      return {
        ...parsed,
        people: { ...parsed.people, "Alan Turing": ada },
        total: Math.round((parsed.total! - delta) * 100) / 100,
      };
    },
  });
  await processStatement(statementMail, h.deps);
  const html = htmlOf(h.sent[0]);

  assert.match(html, /One at a time:/, "a grouped card needs a per-person fallback");
  assert.match(buttonHref(html), /recipients=[^"&]+,[^"&]+/, "and the button charges both at once");
});

test("a single-person card has no fallback row, because it is already one", async () => {
  const h = harness();
  await processStatement(statementMail, h.deps);
  // August's three charges are all distinct amounts -> every card is one person.
  assert.doesNotMatch(htmlOf(h.sent[0]), /One at a time:/);
});
