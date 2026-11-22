import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import type { DeliveryStore, DeliveryState, Snapshot } from "./delivery.js";

export const STATE_PATH = "fi-group-repay/state.json";

export const blobStore: DeliveryStore = {
  async read(): Promise<Snapshot> {
    const blob = await get(STATE_PATH, { access: "private", useCache: false });
    if (!blob) return { state: { history: [], completed: [] } };
    if (blob.statusCode !== 200) throw new Error("Cannot read statement state");
    return {
      etag: blob.blob.etag,
      state: await new Response(blob.stream).json() as DeliveryState,
    };
  },
  async write(snapshot, state) {
    try {
      await put(STATE_PATH, JSON.stringify(state), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: Boolean(snapshot.etag),
        ifMatch: snapshot.etag,
      });
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) {
        return false;
      }
      if (!snapshot.etag && (await blobStore.read()).etag) return false;
      throw error;
    }
  },
};
