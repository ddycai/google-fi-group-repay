import { Webhook } from "standardwebhooks";
import { deliver, DeliveryStateError, type DeliveryStore, type Envelope } from "./delivery.js";
import { parseStatementPdf } from "./parse.js";
import {
  addressOf,
  FORWARDING_CONFIRMATION_SENDER,
  processStatement,
  type IncomingMail,
} from "./process.js";
import type { Config } from "./types.js";

const MAX_PDF_BYTES = 10 * 1024 * 1024;

class DiagnosticError extends Error {}
class RetrievalError extends DiagnosticError {}

interface ReceivedEmail {
  from: string;
  to: string[];
  subject?: string;
  text?: string;
}

interface Attachment {
  filename?: string;
  content_type?: string;
  size: number;
  download_url: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new DiagnosticError(`Missing ${key}`);
  return value;
}

async function download(attachment: Attachment, fetcher: typeof fetch): Promise<Uint8Array> {
  if (attachment.size > MAX_PDF_BYTES) throw new Error("PDF exceeds the 10 MiB limit");
  try {
    const url = new URL(attachment.download_url);
    if (url.protocol !== "https:") throw new Error("Invalid attachment URL");
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) throw new Error("Attachment download failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_PDF_BYTES) break;
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    if (size <= MAX_PDF_BYTES) {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }
  } catch {
    throw new RetrievalError("Unable to retrieve PDF from Resend");
  }
  throw new Error("PDF exceeds the 10 MiB limit");
}

export async function handleWebhook(
  request: Request,
  env: NodeJS.ProcessEnv,
  store: DeliveryStore,
  fetcher = fetch,
): Promise<Response> {
  let verifier: Webhook;
  try {
    verifier = new Webhook(required(env, "RESEND_WEBHOOK_SECRET"));
  } catch {
    console.error("Resend webhook signing secret is missing or invalid");
    return new Response(null, { status: 503 });
  }

  let event: { type?: string; data?: { email_id?: string; to?: string[] } };
  try {
    // Resend uses Svix header names for the Standard Webhooks signature format.
    event = verifier.verify(await request.text(), {
      "webhook-id": request.headers.get("svix-id") ?? "",
      "webhook-timestamp": request.headers.get("svix-timestamp") ?? "",
      "webhook-signature": request.headers.get("svix-signature") ?? "",
    }) as typeof event;
  } catch {
    return new Response(null, { status: 401 });
  }

  if (event?.type !== "email.received") return new Response(null, { status: 204 });
  const id = event.data?.email_id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    return new Response(null, { status: 400 });
  }

  let operation = "load webhook configuration";
  try {
    const inbound = required(env, "FI_GROUP_REPAY_INBOUND").toLowerCase();
    const addressedToApp = (to: string[] | undefined) =>
      Array.isArray(to) && to.some((address) => addressOf(address) === inbound);
    if (!addressedToApp(event.data?.to)) return new Response(null, { status: 204 });

    const from = required(env, "FI_GROUP_REPAY_FROM");
    const to = required(env, "FI_GROUP_REPAY_TO");
    const key = required(env, "RESEND_API_KEY");
    const config = JSON.parse(required(env, "FI_GROUP_REPAY_CONFIG")) as Config;
    if (!Array.isArray(config.people) || typeof config.noteTemplate !== "string") {
      throw new DiagnosticError("Invalid roster configuration");
    }
    const allowedSenders = (env.FI_GROUP_REPAY_ALLOWED_SENDERS ?? "payments-noreply@google.com")
      .split(",").map(addressOf).filter(Boolean);

    async function resend(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${key}`);
      const response = await fetcher(`https://api.resend.com${path}`, {
        ...init, headers, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new RetrievalError(`Resend request returned HTTP ${response.status}`);
      return response;
    }

    const deliveryStore: DeliveryStore = {
      async read() {
        operation = "read Blob state";
        const snapshot = await store.read();
        operation = "check delivery state";
        return snapshot;
      },
      async write(snapshot, state) {
        operation = "write Blob state";
        const written = await store.write(snapshot, state);
        operation = "check delivery state";
        return written;
      },
    };
    await deliver(id, deliveryStore, async (history) => {
      operation = "retrieve inbound email";
      const path = `/emails/receiving/${id}`;
      const message = await (await resend(path)).json() as ReceivedEmail;
      if (!addressedToApp(message.to)) return { history };
      const sender = addressOf(message.from);
      const confirmation = sender === FORWARDING_CONFIRMATION_SENDER;
      if (!confirmation && !allowedSenders.includes(sender)) return { history };

      operation = "prepare inbound email";
      const attachments = confirmation ? [] :
        (await (await resend(`${path}/attachments`)).json() as { data: Attachment[] }).data;
      const incoming: IncomingMail = {
        ...message,
        attachments: attachments.map((file) => ({
          name: file.filename ?? "",
          type: file.content_type ?? "",
          bytes: () => download(file, fetcher),
        })),
      };

      let mail: Envelope | undefined;
      let nextHistory = history;
      try {
        // Stage both effects before attempting external delivery.
        await processStatement(incoming, {
          config,
          allowedSenders,
          parsePdf: parseStatementPdf,
          getHistory: async () => history,
          saveHistory: async (next) => { nextHistory = next; },
          send: async (outgoing) => { mail = { ...outgoing, from, to }; },
        });
      } catch (error) {
        if (error instanceof RetrievalError) throw error;
        mail = {
          from, to,
          subject: "google-fi-group-repay failed to process a Google Fi statement",
          text: "The statement could not be processed. Open the original Fi email to review the bill.\n\n" +
            (error instanceof Error ? error.message : "Unknown processing error"),
        };
      }
      return { mail, history: nextHistory };
    }, async (mail, deliveryId) => {
      operation = "send outbound email";
      await resend("/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `fi-group-repay/${deliveryId}`,
        },
        body: JSON.stringify(mail),
      });
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    // Avoid logging the message, signed attachment URLs, or provider response bodies.
    console.error("Fi statement webhook needs retry", {
      id,
      operation,
      reason: error instanceof DiagnosticError || error instanceof DeliveryStateError ? error.message : error instanceof Error ? error.name : "Unknown",
    });
    return new Response(null, { status: 503 });
  }
}
