import { blobStore } from "../src/blob-store.js";
async function main() {
  const [action, value, extra] = process.argv.slice(2);
  if (extra || !(
    (action === "status" && !value) ||
    (value && (action === "confirm-sent" || action === "confirm-unsent"))
  )) {
    throw new Error("Usage: npm run statement-state -- status | confirm-sent <id> | confirm-unsent <id>");
  }
  const snapshot = await blobStore.read();
  const { state } = snapshot;
  if (action === "status") {
    console.log(JSON.stringify({
      statementDates: state.history.map((record) => record.statementDate),
      completed: state.completed.length,
      pending: state.pending && { id: state.pending.id, startedAt: new Date(state.pending.startedAt) },
    }, null, 2));
    return;
  }
  const { pending } = state;
  if (!pending || pending.id !== value) throw new Error("That email ID is not pending");
  if (Date.now() - pending.startedAt < 24 * 60 * 60 * 1000) {
    throw new Error("Wait at least 24 hours after the pending delivery began before reconciling");
  }
  const next = action === "confirm-sent"
    ? { history: pending.history, completed: [...state.completed, pending.id] }
    : { history: state.history, completed: state.completed };
  if (!await blobStore.write(snapshot, next)) throw new Error("State changed during reconciliation");
  console.log(action === "confirm-sent" ? "Recorded delivery" : "Pending delivery cleared. Replay the event in Resend");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "State operation failed");
  process.exitCode = 1;
});
