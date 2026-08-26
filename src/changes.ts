import { toCents } from "./split.js";

export interface AmountChange {
  name: string;
  /** Dollars last month, or null if they weren't on that statement. */
  from: number | null;
  /** Dollars this month, or null if they've dropped off. */
  to: number | null;
}

/**
 * Compare this statement's per-person amounts with the previous one.
 *
 * The point isn't bookkeeping — it's that these amounts are usually identical
 * month to month, so the month they aren't is the month worth looking at. A
 * device payment ending or a one-off credit lands here.
 */
export function diffAmounts(
  previous: Record<string, number> | undefined,
  current: Record<string, number>,
): AmountChange[] {
  if (!previous) return [];

  const names = [...new Set([...Object.keys(previous), ...Object.keys(current)])];
  const changes: AmountChange[] = [];

  for (const name of names) {
    const before = previous[name];
    const after = current[name];

    if (before === undefined) {
      changes.push({ name, from: null, to: after! });
    } else if (after === undefined) {
      changes.push({ name, from: before, to: null });
    } else if (toCents(before) !== toCents(after)) {
      changes.push({ name, from: before, to: after });
    }
  }

  return changes;
}

export function describeChange(change: AmountChange): string {
  const { name, from, to } = change;
  if (from === null) return `${name} added at $${to!.toFixed(2)}`;
  if (to === null) return `${name} dropped off (was $${from.toFixed(2)})`;

  const direction = to > from ? "up" : "down";
  return `${name} ${direction} $${Math.abs(to - from).toFixed(2)} — $${from.toFixed(2)} → $${to.toFixed(2)}`;
}

export function buildSubject(
  month: string,
  totalDollars: number,
  changes: AmountChange[],
  isFirstRun: boolean,
): string {
  const head = `Google Fi ${month} — $${totalDollars.toFixed(2)}`;
  if (isFirstRun) return `${head} — first run`;
  if (changes.length === 0) return head;

  const noun = changes.length === 1 ? "amount" : "amounts";
  return `${head} — ${changes.length} ${noun} changed`;
}
