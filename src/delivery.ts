import type { StatementRecord } from "./history.js";
import type { OutgoingMail } from "./process.js";

export class DeliveryStateError extends Error {}

export interface Envelope extends OutgoingMail {
  from: string;
  to: string;
}

interface Pending {
  id: string;
  startedAt: number;
  mail: Envelope;
  history: StatementRecord[];
}

export interface DeliveryState {
  history: StatementRecord[];
  completed: string[];
  pending?: Pending;
}

export interface Snapshot {
  etag?: string;
  state: DeliveryState;
}

export interface DeliveryStore {
  read(): Promise<Snapshot>;
  write(snapshot: Snapshot, state: DeliveryState): Promise<boolean>;
}

export async function deliver(
  id: string,
  store: DeliveryStore,
  prepare: (history: StatementRecord[]) => Promise<{ mail?: Envelope; history: StatementRecord[] }>,
  send: (mail: Envelope, id: string) => Promise<void>,
  now = Date.now,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = await store.read();
    const { state } = snapshot;
    if (state.completed.includes(id)) return;

    if (state.pending) {
      const { pending } = state;
      // Resend keeps keys for 24 hours. Leave a margin for timeouts and clock drift.
      if (now() - pending.startedAt >= 23 * 60 * 60 * 1000) {
        throw new DeliveryStateError("Pending delivery needs reconciliation in Resend");
      }
      await send(pending.mail, pending.id);
      const written = await store.write(snapshot, {
        history: pending.history,
        completed: [...state.completed, pending.id],
      });
      if (written && pending.id === id) return;
      continue;
    }

    const prepared = await prepare(state.history);
    if (!prepared.mail) return;
    await store.write(snapshot, {
      ...state,
      pending: { id, startedAt: now(), mail: prepared.mail, history: prepared.history },
    });
  }
  throw new DeliveryStateError("Could not advance statement state after 8 attempts");
}
