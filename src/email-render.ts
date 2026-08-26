import { type AmountChange, describeChange } from "./changes.js";
import { type ChargeRow, groupCharges, listNames } from "./links.js";
import { formatCents } from "./split.js";
import type { Share } from "./types.js";

/**
 * Styles are inline throughout: Gmail and friends strip or partially honour
 * <style> blocks, and a stripped stylesheet here would mean unlabelled links
 * in the one message that has to be tappable on a phone.
 */
const BUTTON =
  "display:block;padding:14px 16px;border-radius:10px;background:#008cff;color:#ffffff;" +
  "font-weight:600;text-decoration:none;text-align:center;font-size:16px";
const CARD =
  "border:1px solid #e3e6ea;border-radius:12px;padding:16px;margin:0 0 12px";
const MUTED = "color:#6b7280;font-size:13px;margin:0";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface EmailInput {
  month: string;
  charges: ChargeRow[];
  owner: Share;
  billTotalCents: number;
  changes: AmountChange[];
  isFirstRun: boolean;
}

export function renderEmailHtml(input: EmailInput): string {
  const { month, charges, owner, billTotalCents, changes, isFirstRun } = input;
  const collecting = charges.reduce((sum, c) => sum + c.share.totalCents, 0);

  const banner = renderBanner(changes, isFirstRun);

  const groups = groupCharges(charges);

  const cards = groups
    .map((g) => {
      const names = listNames(g.members.map((m) => m.share.name));
      const handles = g.members.map((m) => `@${m.username}`).join(", ");

      // A grouped charge is the least documented part of this, so a group card
      // also offers the same request one person at a time. A single-person
      // card needs no fallback: it is already that.
      const alone = g.members.length === 1;
      const fallback = alone
        ? ""
        : `<p style="${MUTED};margin-top:12px;text-align:center">One at a time: ${g.members
            .map(
              (m) =>
                `<a href="${escapeHtml(m.link)}" style="color:#6b7280">${escapeHtml(m.share.name)}</a>`,
            )
            .join(" · ")}</p>`;

      return `
      <div style="${CARD}">
        <p style="margin:0 0 4px;font-weight:600;font-size:16px">${escapeHtml(names)}</p>
        <p style="${MUTED};margin-bottom:14px">${escapeHtml(handles)}</p>
        <a href="${escapeHtml(g.link)}" style="${BUTTON}">Request $${escapeHtml(g.amount)}${
          alone ? "" : ` from ${g.members.length}`
        }</a>
        ${fallback}
      </div>`;
    })
    .join("");

  const tapCount =
    groups.length === 1 ? "one tap" : `${groups.length} taps`;

  return `<!doctype html>
<html>
<body style="margin:0;padding:24px 16px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#14161a">
  <div style="max-width:520px;margin:0 auto">
    <h1 style="font-size:20px;margin:0 0 4px">Google Fi — ${escapeHtml(month)}</h1>
    <p style="${MUTED};margin-bottom:20px">
      Bill ${formatCents(billTotalCents)} · collecting ${formatCents(collecting)} ·
      your share ${formatCents(owner.totalCents)}
    </p>
    ${banner}
    ${cards}
    <p style="${MUTED};text-align:center;margin-top:24px">
      ${tapCount} to collect ${formatCents(collecting)}. Each button opens Venmo with the
      request prefilled — nothing is sent until you confirm in the app.
    </p>
  </div>
</body>
</html>`;
}

function renderBanner(changes: AmountChange[], isFirstRun: boolean): string {
  if (isFirstRun) {
    return `<div style="${CARD};background:#f2f4f7;border-color:#d8dce2">
      <p style="margin:0;font-size:14px">
        First run — nothing to compare against yet. From next month you'll see any amount that moved.
      </p>
    </div>`;
  }

  if (changes.length === 0) return "";

  const items = changes
    .map((c) => `<li style="margin:0 0 4px">${escapeHtml(describeChange(c))}</li>`)
    .join("");

  return `<div style="${CARD};background:#fff8e6;border-color:#f0d999">
    <p style="margin:0 0 8px;font-weight:600;font-size:14px">Amounts changed since last month</p>
    <ul style="margin:0;padding-left:20px;font-size:14px">${items}</ul>
  </div>`;
}

export function renderEmailText(input: EmailInput): string {
  const { month, charges, owner, billTotalCents, changes, isFirstRun } = input;
  const collecting = charges.reduce((sum, c) => sum + c.share.totalCents, 0);

  const lines = [
    `Google Fi — ${month}`,
    `Bill ${formatCents(billTotalCents)} · collecting ${formatCents(collecting)} · your share ${formatCents(owner.totalCents)}`,
    "",
  ];

  if (isFirstRun) {
    lines.push("First run — nothing to compare against yet.", "");
  } else if (changes.length > 0) {
    lines.push("Amounts changed since last month:");
    lines.push(...changes.map((c) => `  - ${describeChange(c)}`));
    lines.push("");
  }

  for (const g of groupCharges(charges)) {
    const alone = g.members.length === 1;
    lines.push(`${listNames(g.members.map((m) => m.share.name))} — $${g.amount}${alone ? "" : " each"}`);

    lines.push(`  ${g.link}`);
    if (!alone) {
      lines.push("  One at a time:");
      lines.push(...g.members.map((m) => `    ${m.share.name}: ${m.link}`));
    }
    lines.push("");
  }

  lines.push("Each link opens Venmo with the request prefilled. Nothing is sent until you confirm.");
  return lines.join("\n");
}
