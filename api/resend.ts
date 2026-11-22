import { blobStore } from "../src/blob-store.js";
import { handleWebhook } from "../src/resend-webhook.js";

export function POST(request: Request): Promise<Response> {
  return handleWebhook(request, process.env, blobStore);
}
