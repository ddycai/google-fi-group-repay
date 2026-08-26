import { buildSubject, diffAmounts } from "./changes.js";
import { renderEmailHtml, renderEmailText } from "./email-render.js";
import { type StatementRecord, updateHistory } from "./history.js";
import { buildCharges } from "./links.js";
import type { ParsedStatement } from "./parse.js";
import { chargeable, computeShares } from "./split.js";
import type { Config } from "./types.js";

export interface IncomingMail {
  from: string;
  subject?: string;
  text?: string;
  attachments: Array<{ name: string; type: string; bytes: () => Promise<Uint8Array> }>;
}

/**
 * Gmail will not forward to a new address until you confirm a code it sends to
 * that address — which nobody can read when the address is a val. Recognise
 * that one message and pass it through, or setup is a dead end.
 */
export const FORWARDING_CONFIRMATION_SENDER = "forwarding-noreply@google.com";

export interface OutgoingMail {
  subject: string;
  text: string;
  /**
   * Omitted for text-only mail. Val Town's email() rejects an empty string
   * ("body/html must NOT have fewer than 1 characters"), so absent and empty
   * are not interchangeable here.
   */
  html?: string;
}

export interface ProcessDeps {
  config: Config;
  allowedSenders: string[];
  parsePdf(bytes: Uint8Array): Promise<ParsedStatement>;
  getHistory(): Promise<StatementRecord[] | undefined>;
  saveHistory(next: StatementRecord[]): Promise<void>;
  send(mail: OutgoingMail): Promise<void>;
}

export type ProcessResult =
  | { status: "ignored"; reason: string }
  | { status: "confirmation" }
  | { status: "sent"; month: string; charged: number; isRepeat: boolean };

/** "Google Payments <payments-noreply@google.com>" -> the address, lowercased. */
export function addressOf(from: string): string {
  const angled = /<([^>]+)>/.exec(from);
  return (angled?.[1] ?? from).trim().toLowerCase();
}

export function findPdf<T extends { name: string; type: string }>(attachments: T[]): T {
  const pdfs = attachments.filter(
    (a) => a.type === "application/pdf" || /\.pdf$/i.test(a.name),
  );
  if (pdfs.length === 0) {
    throw new Error(
      "No PDF attachment. The Fi statement carries the per-member breakdown as an " +
        "attachment; the email body has only the total.",
    );
  }
  if (pdfs.length > 1) {
    throw new Error(`Expected one PDF attachment, found ${pdfs.length}.`);
  }
  return pdfs[0]!;
}

/**
 * Statement email in, charge-link email out.
 *
 * All I/O is injected so this can be exercised without a Val Town runtime —
 * which matters, because the alternative is discovering a bug once a month.
 */
export async function processStatement(
  message: IncomingMail,
  deps: ProcessDeps,
): Promise<ProcessResult> {
  const sender = addressOf(message.from);

  if (sender === FORWARDING_CONFIRMATION_SENDER) {
    // Relayed verbatim as text, never parsed or acted on — it exists only so a
    // human can read the code out of it during setup.
    await deps.send({
      subject: "google-fi-group-repay: Gmail forwarding confirmation",
      text: [
        "Gmail sent a forwarding confirmation to the google-fi-group-repay address.",
        "Copy the code or link below into Gmail's forwarding settings.",
        "",
        message.text ?? "(no text body)",
      ].join("\n"),
    });
    return { status: "confirmation" };
  }

  if (!deps.allowedSenders.includes(sender)) {
    // Anyone who learns the trigger address can post to it. Refuse rather than
    // parse an untrusted PDF.
    return { status: "ignored", reason: `sender ${sender} is not allowed` };
  }

  const pdf = findPdf(message.attachments);
  const { statementDate, ...bill } = await deps.parsePdf(await pdf.bytes());

  // Throws if a name on the statement isn't in config, if someone in config is
  // missing, or if the amounts don't sum to the stated total — which is also
  // what stops a doctored PDF producing plausible-looking charges.
  const shares = computeShares(bill, deps.config);
  const owner = shares.find((s) => s.isOwner)!;
  const charges = buildCharges(chargeable(shares), deps.config.noteTemplate, bill.month);

  const record: StatementRecord = {
    statementDate,
    people: bill.people,
    total: bill.total!,
  };
  const { baseline, isRepeat, next } = updateHistory(await deps.getHistory(), record);
  const changes = diffAmounts(baseline?.people, bill.people);
  const isFirstRun = baseline === undefined;

  const input = {
    month: bill.month,
    charges,
    owner,
    billTotalCents: shares.reduce((sum, s) => sum + s.totalCents, 0),
    changes,
    isFirstRun,
  };

  const subject = buildSubject(bill.month, bill.total!, changes, isFirstRun);
  await deps.send({
    subject: isRepeat ? `${subject} (repeat)` : subject,
    html: renderEmailHtml(input),
    text: renderEmailText(input),
  });

  // Only after the mail is away — a send failure should not consume the month.
  if (!isRepeat) await deps.saveHistory(next);

  return { status: "sent", month: bill.month, charged: charges.length, isRepeat };
}
