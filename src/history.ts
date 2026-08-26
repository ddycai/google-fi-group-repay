export interface StatementRecord {
  /** As printed on the statement, e.g. "Aug 17, 2026". The identity of a statement. */
  statementDate: string;
  people: Record<string, number>;
  total: number;
}

/**
 * This statement and the one before it — the whole question is "did anything
 * change since last month". Two rather than one because a repeat needs a
 * baseline that isn't itself; see `updateHistory`.
 */
const KEEP = 2;

export interface HistoryUpdate {
  /** The most recent *different* statement, to compare against. */
  baseline: StatementRecord | undefined;
  /** This exact statement has been processed before. */
  isRepeat: boolean;
  /** History to persist. Unchanged when this is a repeat. */
  next: StatementRecord[];
}

/**
 * Fold a freshly parsed statement into the stored history.
 *
 * Statements are identified by their printed date, not by arrival. A forwarded
 * email can easily arrive twice, and treating the second copy as a new month
 * would overwrite the very baseline the change detection needs — silently
 * turning every future comparison into "nothing changed".
 */
export function updateHistory(
  history: StatementRecord[] | undefined,
  current: StatementRecord,
): HistoryUpdate {
  const records = history ?? [];
  const isRepeat = records.some((r) => r.statementDate === current.statementDate);
  const baseline = records.find((r) => r.statementDate !== current.statementDate);

  return {
    baseline,
    isRepeat,
    next: isRepeat ? records : [current, ...records].slice(0, KEEP),
  };
}
