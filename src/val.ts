// ⚠ NOT the file to deploy. Its relative imports do not exist on Val Town,
// which fails at runtime with ERR_MODULE_NOT_FOUND on "./parse.js".
//
// Run `npm run build:val` and deploy `valtown/main.ts` instead.

import { blob } from "https://esm.town/v/std/blob";
import { email } from "https://esm.town/v/std/email";
import type { StatementRecord } from "./history.js";
import { parseStatementPdf } from "./parse.js";
import { type IncomingMail, type ProcessDeps, processStatement } from "./process.js";
import type { Config } from "./types.js";

// Deliberately not "google-fi-group-repay:statements". The repo was renamed;
// this key was not, because changing it orphans the stored baseline and the
// next run reports as a first run with no change detection.
const BLOB_KEY = "fi-group-repay:statements";
const DEFAULT_SENDERS = ["payments-noreply@google.com"];

function allowedSenders(): string[] {
  const configured = Deno.env.get("FI_GROUP_REPAY_ALLOWED_SENDERS");
  if (!configured) return DEFAULT_SENDERS;
  return configured
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function loadConfig(): Config {
  const raw = Deno.env.get("FI_GROUP_REPAY_CONFIG");
  if (!raw) {
    throw new Error("FI_GROUP_REPAY_CONFIG is not set. It should hold the contents of config.json.");
  }
  try {
    return JSON.parse(raw) as Config;
  } catch (error) {
    throw new Error(
      `FI_GROUP_REPAY_CONFIG is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function adapt(message: ValTownEmail): IncomingMail {
  return {
    from: message.from,
    subject: message.subject,
    text: message.text,
    attachments: message.attachments.map((file) => ({
      name: file.name,
      type: file.type,
      bytes: async () => new Uint8Array(await file.arrayBuffer()),
    })),
  };
}

function deps(): ProcessDeps {
  return {
    config: loadConfig(),
    allowedSenders: allowedSenders(),
    parsePdf: parseStatementPdf,
    getHistory: () => blob.getJSON<StatementRecord[]>(BLOB_KEY),
    saveHistory: (next) => blob.setJSON(BLOB_KEY, next),
    send: async ({ subject, text, html }) => {
      // Val Town rejects an empty html body outright, so drop the field rather
      // than pass "" — text-only mail is legitimate here.
      await email(html ? { subject, text, html } : { subject, text });
    },
  };
}

async function reportFailure(message: ValTownEmail, error: unknown): Promise<void> {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(detail);

  // A silent failure means a month of nobody being charged, so make it loud.
  await email({
    subject: "google-fi-group-repay failed to process a Google Fi statement",
    text: [
      "google-fi-group-repay could not turn the attached statement into charge links.",
      "",
      `From:    ${message.from}`,
      `Subject: ${message.subject ?? "(none)"}`,
      `Files:   ${message.attachments.map((a) => a.name).join(", ") || "(none)"}`,
      "",
      detail,
      "",
      "The bill still needs collecting — open the statement and request manually.",
    ].join("\n"),
  });
}

export default async function handleStatement(message: ValTownEmail): Promise<void> {
  try {
    const result = await processStatement(adapt(message), deps());
    console.log(JSON.stringify(result));
  } catch (error) {
    await reportFailure(message, error);
  }
}
