import assert from "node:assert/strict";
import { test } from "node:test";
import { Webhook } from "standardwebhooks";
import { deliver, type DeliveryStore, type DeliveryState } from "../src/delivery.js";
import { handleWebhook } from "../src/resend-webhook.js";

function memoryStore() {
  let state: DeliveryState = { history: [], completed: [] };
  let revision = 0;
  let failCompletion = false;
  return {
    async read() {
      return { etag: String(revision), state: structuredClone(state) };
    },
    async write(snapshot, next) {
      if (snapshot.etag !== String(revision)) return false;
      if (failCompletion && state.pending && !next.pending) {
        failCompletion = false;
        throw new Error("Storage temporarily unavailable");
      }
      state = structuredClone(next);
      revision++;
      return true;
    },
    failNextCompletion() { failCompletion = true; },
  } satisfies DeliveryStore & { failNextCompletion(): void };
}

const inbound = "fixture@example.resend.app";
const secret = "whsec_" + Buffer.from("local test signing secret").toString("base64");
const env = {
  RESEND_WEBHOOK_SECRET: secret,
  RESEND_API_KEY: "test",
  FI_GROUP_REPAY_INBOUND: inbound,
  FI_GROUP_REPAY_FROM: "bot@example.com",
  FI_GROUP_REPAY_TO: "owner@example.com",
  FI_GROUP_REPAY_CONFIG: JSON.stringify({
    people: [{ name: "Owner", isOwner: true }, { name: "Friend", venmo: "friend" }],
    noteTemplate: "Fi {month}",
  }),
};
function event(id: string, options: { tamper?: boolean; to?: string } = {}) {
  const body = JSON.stringify({
    type: "email.received",
    data: { email_id: id, to: [options.to ?? inbound] },
  });
  const timestamp = new Date();
  const eventId = `event-${id}`;
  return new Request("https://example.com/api/resend", {
    method: "POST",
    headers: {
      "svix-id": eventId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(eventId, timestamp, body),
    },
    body: options.tamper ? body + " " : body,
  });
}

test("rejects a tampered notification and ignores a different inbox before provider calls", async () => {
  const fetcher: typeof fetch = async () => assert.fail("Unexpected provider call");
  assert.equal((await handleWebhook(event("one", { tamper: true }), env, memoryStore(), fetcher)).status, 401);
  assert.equal((await handleWebhook(event("one", { to: "other@example.com" }), env, memoryStore(), fetcher)).status, 204);
});

test("relays Gmail confirmation once across webhook retries", async () => {
  const store = memoryStore();
  let sent = 0;
  const fetcher: typeof fetch = async (url, init) => {
    switch (String(url)) {
      case "https://api.resend.com/emails/receiving/confirmation":
        return Response.json({ from: "Gmail <forwarding-noreply@google.com>", to: [inbound], text: "Code 123456" });
      case "https://api.resend.com/emails": {
        sent++;
        const mail = JSON.parse(String(init?.body));
        assert.equal(mail.to, env.FI_GROUP_REPAY_TO);
        assert.match(mail.text, /123456/);
        assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "fi-group-repay/confirmation");
        return Response.json({ id: "sent" });
      }
      default: return assert.fail(`Unexpected URL ${String(url)}`);
    }
  };
  for (let i = 0; i < 2; i++) {
    assert.equal((await handleWebhook(event("confirmation"), env, store, fetcher)).status, 204);
  }
  assert.equal(sent, 1);
});

test("an unapproved sender cannot cause an attachment download or outbound email", async () => {
  const fetcher: typeof fetch = async (url) => {
    assert.equal(String(url), "https://api.resend.com/emails/receiving/unapproved");
    return Response.json({ from: "unapproved@example.com", to: [inbound] });
  };
  assert.equal((await handleWebhook(event("unapproved"), env, memoryStore(), fetcher)).status, 204);
});

test("a failed history write recovers with the same email key and staged message", async () => {
  const store = memoryStore();
  const accepted = new Map<string, unknown>();
  const mail = { from: "bot@example.com", to: "owner@example.com", subject: "Summary", text: "Bill" };
  const history = [{ statementDate: "Aug 17, 2026", people: { Owner: 60, Friend: 40 }, total: 100 }];
  let prepares = 0;
  let attempts = 0;
  const run = () => deliver("same-email", store, async () => {
    prepares++;
    return { mail, history };
  }, async (envelope, id) => {
    attempts++;
    if (accepted.has(id)) assert.deepEqual(envelope, accepted.get(id));
    accepted.set(id, envelope);
  });
  store.failNextCompletion();
  await assert.rejects(run(), /temporarily unavailable/);
  assert.deepEqual((await store.read()).state.history, []);
  await run();
  await run();
  assert.equal(prepares, 1);
  assert.equal(attempts, 2);
  assert.equal(accepted.size, 1);
  assert.deepEqual((await store.read()).state, { history, completed: ["same-email"] });
});

test("concurrent messages prepare against the latest committed history", async () => {
  const store = memoryStore();
  const mail = { from: "bot@example.com", to: "owner@example.com", subject: "Summary", text: "Bill" };
  const accepted = new Set<string>();
  const run = (id: string) => deliver(id, store, async (history) => ({
    mail,
    history: [{ statementDate: id, people: { Owner: 60, Friend: 40 }, total: 100 }, ...history],
  }), async (_, key) => { accepted.add(key); });
  await Promise.all([run("one"), run("two")]);
  const { state } = await store.read();
  assert.equal(state.history.length, 2);
  assert.equal(state.completed.length, 2);
  assert.equal(accepted.size, 2);
});

// A synthetic PDF with the same text layout as the statement table.
function statementPdf(friendAmount: number) {
  const lines = [
    "monthly statement for Aug 17, 2026", "Owner", "$60.00",
    "Friend", `$${friendAmount.toFixed(2)}`, "Total", `$${(60 + friendAmount).toFixed(2)}`,
  ];
  const stream = "BT /F1 12 Tf 16 TL 50 750 Td\n" +
    lines.map((line) => `(${line}) Tj T*`).join("\n") + "\nET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

test("downloads and parses PDF bytes, sends the summary, and labels a separately forwarded repeat", async () => {
  const store = memoryStore();
  const sent: Array<{ subject: string; html: string }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/attachments")) {
      return Response.json({ data: [{
        filename: "statement.pdf", content_type: "application/pdf",
        size: 1000, download_url: "https://inbound-cdn.resend.com/fixture.pdf",
      }] });
    }
    if (path === "/fixture.pdf") {
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      return new Response(statementPdf(40));
    }
    if (path === "/emails") {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "sent" });
    }
    return Response.json({ from: "payments-noreply@google.com", to: [inbound] });
  };
  for (const id of ["statement", "statement", "forwarded-again"]) {
    assert.equal((await handleWebhook(event(id), env, store, fetcher)).status, 204);
  }
  assert.equal(sent.length, 2);
  assert.match(sent[0]!.html, /venmo\.com\/friend\?txn=charge/);
  assert.match(sent[1]!.subject, /\(repeat\)$/);
  assert.deepEqual((await store.read()).state.history, [
    { statementDate: "Aug 17, 2026", people: { Owner: 60, Friend: 40 }, total: 100 },
  ]);
});

test("retries temporary retrieval failures and reports an invalid statement only once", async () => {
  const store = memoryStore();
  let attachmentAttempts = 0;
  let alerts = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/attachments")) {
      attachmentAttempts++;
      return attachmentAttempts === 1 ? new Response(null, { status: 503 }) : Response.json({ data: [] });
    }
    if (path === "/emails") {
      alerts++;
      assert.match(JSON.parse(String(init?.body)).text, /No PDF attachment/);
      return Response.json({ id: "sent" });
    }
    return Response.json({ from: "payments-noreply@google.com", to: [inbound] });
  };
  assert.equal((await handleWebhook(event("missing-pdf"), env, store, fetcher)).status, 503);
  assert.equal(alerts, 0);
  assert.equal((await handleWebhook(event("missing-pdf"), env, store, fetcher)).status, 204);
  assert.equal((await handleWebhook(event("missing-pdf"), env, store, fetcher)).status, 204);
  assert.equal(alerts, 1);
  assert.deepEqual((await store.read()).state.history, []);
});

test("expired pending mail requires reconciliation before another send", async () => {
  const store = memoryStore();
  let time = 0;
  let attempts = 0;
  const run = () => deliver("expired", store, async (history) => ({
    history,
    mail: { from: "bot@example.com", to: "owner@example.com", text: "Bill", subject: "Summary" },
  }), async () => {
    attempts++;
    throw new Error("Uncertain send outcome");
  }, () => time);
  await assert.rejects(run(), /Uncertain send outcome/);
  time = 24 * 60 * 60 * 1000;
  await assert.rejects(run(), /needs reconciliation/);
  assert.equal(attempts, 1);
});
