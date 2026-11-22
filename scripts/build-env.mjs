import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const IN = "config.json";
const [vercelFile = ".env.vercel", ...extraArgs] = process.argv.slice(2);
if (extraArgs.length || !/^\.env\.vercel(?:-[a-zA-Z0-9_-]+)?$/.test(vercelFile)) {
  throw new Error("Usage: npm run build:env -- [.env.vercel | .env.vercel-live]");
}

const config = JSON.parse(await readFile(IN, "utf8"));

const people = config.people ?? [];
const owners = people.filter((p) => p.isOwner);
if (owners.length !== 1) {
  throw new Error(`${IN} needs exactly one person with "isOwner": true, found ${owners.length}.`);
}
// Must match what config.example.json actually ships. It previously looked
// only for FILL-ME-IN, which appears nowhere in the example, so the guard
// never fired on the file it exists to catch.
const PLACEHOLDER_HANDLE = /^(FILL-ME-IN|friend-\w+-handle|your-handle)$/i;
const unset = people.filter(
  (p) => !p.isOwner && (!p.venmo || PLACEHOLDER_HANDLE.test(p.venmo.trim())),
);
if (unset.length > 0) {
  throw new Error(
    `${IN} still has placeholder Venmo handles: ${unset.map((p) => p.name).join(", ")}`,
  );
}

const { allowedSenders = ["payments-noreply@google.com"], ...roster } = config;
if (!Array.isArray(allowedSenders) || allowedSenders.length === 0) {
  throw new Error(`${IN}: "allowedSenders" must be a non-empty array of addresses.`);
}

const PLACEHOLDER_SENDER = /^your-email@example\.com$/i;
const placeholderSenders = allowedSenders.filter((s) =>
  PLACEHOLDER_SENDER.test(String(s).trim()),
);
if (placeholderSenders.length > 0) {
  throw new Error(
    `${IN}: "allowedSenders" still contains the placeholder ${placeholderSenders.join(", ")}. ` +
      `Replace it with your own address, or remove it if you only use Gmail's ` +
      `automatic forwarding.`,
  );
}

// Minified onto one line: dotenv format has no agreed multi-line syntax, and a
// value broken across lines is the classic way one of these silently truncates.
const value = JSON.stringify(roster);

const senders = allowedSenders.map((s) => String(s).trim().toLowerCase()).join(",");

const existing = await readFile(vercelFile, "utf8").then(parseEnv, (error) => {
  if (error.code !== "ENOENT") throw error;
  return {};
});

const vercelDefaults = {
  FI_GROUP_REPAY_INBOUND: "",
  FI_GROUP_REPAY_FROM: "onboarding@resend.dev",
  FI_GROUP_REPAY_TO: "",
  RESEND_API_KEY: "",
  RESEND_WEBHOOK_SECRET: "",
};
const vercel = {
  ...vercelDefaults,
  ...existing,
  FI_GROUP_REPAY_CONFIG: value,
  FI_GROUP_REPAY_ALLOWED_SENDERS: senders,
};

function envLine(name, entry) {
  if (entry === "") return `${name}=`;
  for (const quote of ["'", '"', "`"]) {
    const line = `${name}=${quote}${entry}${quote}`;
    if (parseEnv(line)[name] === entry) return line;
  }
  throw new Error(`Cannot safely write ${name} in ${vercelFile}.`);
}

const vercelEnv = [
  "# Fill in the Resend values below. Vercel adds Blob settings when you connect the store.",
  "# Rerunning build:env refreshes the roster and sender allowlist and keeps other values.",
  ...Object.entries(vercel).map(([name, entry]) => envLine(name, entry)),
  "",
].join("\n");

await writeFile(vercelFile, vercelEnv, { encoding: "utf8", mode: 0o600 });
await chmod(vercelFile, 0o600);
console.log(`Wrote ${vercelFile} for Vercel.`);
const missing = Object.keys(vercelDefaults).filter((name) => !vercel[name].trim());
if (missing.length) console.log(`Fill in ${vercelFile}: ${missing.join(", ")}`);
