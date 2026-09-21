import type { Share } from "./types.js";

/** Observed cap on Venmo notes; truncate rather than let the link be rejected. */
const NOTE_MAX = 200;

/**
 * `encodeURIComponent` rather than `URLSearchParams`, which encodes spaces as
 * `+`. Both are legal, but `%20` survives every client we might hand this to.
 */
function encode(value: string): string {
  return encodeURIComponent(value);
}

export function normalizeUsername(username: string): string {
  return username.trim().replace(/^@/, "");
}

export function truncateNote(note: string): string {
  return note.length <= NOTE_MAX ? note : `${note.slice(0, NOTE_MAX - 1)}…`;
}

export function amountFromCents(cents: number): string {
  if (cents <= 0) throw new Error(`Charge amount must be positive, got ${cents} cents.`);
  return (cents / 100).toFixed(2);
}

/**
 * One charge link for one or more people. The form depends on how many.
 *
 * **One person — `venmo.com/<user>?txn=charge…`.** On a phone this is the
 * form that reliably opens the Venmo app with the request prefilled.
 *
 * **Several — `account.venmo.com/payment-link?…&recipients=a,b,c`.** The only
 * form that carries a list. It opens in the browser rather than the app, but
 * it works. Two near-misses, both confirmed on a real phone:
 *
 *  - `venmo.com/a,b,c` resolves a single username only and 404s on a list.
 *  - `venmo.com/payment-link?…` sends the phone into an endless redirect loop
 *    between the browser and the app.
 *
 * There is only one `amount` parameter, so everyone in a single link is
 * charged the same. Callers must group by amount first.
 *
 * Usernames are encoded individually and joined with a literal comma; encoding
 * the list would turn the separator into %2C and Venmo would read it as one
 * absurd username.
 */
export function chargeLink(username: string | string[], cents: number, note: string): string {
  const users = (Array.isArray(username) ? username : [username]).map(normalizeUsername);
  if (users.length === 0) throw new Error("No Venmo usernames given.");
  if (users.some((u) => u === "")) throw new Error("Venmo username is empty.");

  const amount = amountFromCents(cents);
  const note_ = encode(truncateNote(note));

  if (users.length === 1) {
    return `https://venmo.com/${encode(users[0]!)}?txn=charge&amount=${amount}&note=${note_}`;
  }

  const recipients = users.map(encode).join(",");
  return `https://account.venmo.com/payment-link?txn=charge&amount=${amount}&note=${note_}&recipients=${recipients}`;
}

export function buildNote(template: string, month: string): string {
  return template.replaceAll("{month}", month);
}

export interface ChargeRow {
  share: Share;
  username: string;
  amount: string;
  note: string;
  link: string;
}

export interface ChargeGroup {
  /** Formatted dollars, e.g. "34.60". Everyone here owes exactly this. */
  amount: string;
  totalCents: number;
  members: ChargeRow[];
  /** One link charging every member at once. */
  link: string;
}

/** "Ada, Grace and Rosalind" */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Bucket people by what they owe, so each bucket is one tap.
 *
 * Usually every share is identical and this collapses to a single link. The
 * months it doesn't are the ones where Fi applied a credit or a device payment
 * to one line.
 *
 * Buckets are ordered largest-first: the point is to get most of the month's
 * requests done in the first tap.
 */
export function groupCharges(rows: ChargeRow[]): ChargeGroup[] {
  const buckets = new Map<number, ChargeRow[]>();
  for (const row of rows) {
    const existing = buckets.get(row.share.totalCents);
    if (existing) existing.push(row);
    else buckets.set(row.share.totalCents, [row]);
  }

  return [...buckets.entries()]
    .map(([totalCents, members]) => {
      const usernames = members.map((m) => m.username);
      const note = members[0]!.note;
      return {
        totalCents,
        amount: amountFromCents(totalCents),
        members,
        link: chargeLink(usernames, totalCents, note),
      };
    })
    .sort((a, b) => b.members.length - a.members.length || b.totalCents - a.totalCents);
}

export function buildCharges(
  shares: Share[],
  noteTemplate: string,
  month: string,
): ChargeRow[] {
  const note = buildNote(noteTemplate, month);

  return shares.map((share) => {
    if (!share.venmo) {
      throw new Error(
        `${share.name} owes ${(share.totalCents / 100).toFixed(2)} but has no "venmo" username in config.`,
      );
    }
    const username = normalizeUsername(share.venmo);
    return {
      share,
      username,
      amount: amountFromCents(share.totalCents),
      note,
      link: chargeLink(username, share.totalCents, note),
    };
  });
}
