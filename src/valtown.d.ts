/**
 * Val Town runs on Deno and resolves these at runtime from URLs. They exist
 * here only so `tsc` can check the handler; the bundler marks them external.
 */

declare module "https://esm.town/v/std/email" {
  export function email(options: {
    subject?: string;
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    text?: string;
    html?: string;
    replyTo?: string;
  }): Promise<unknown>;
}

declare module "https://esm.town/v/std/blob" {
  export const blob: {
    getJSON<T = unknown>(key: string): Promise<T | undefined>;
    setJSON(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<Array<{ key: string }>>;
  };
}

declare const Deno: {
  env: { get(key: string): string | undefined };
};

/** The argument Val Town hands an email-triggered val. */
interface ValTownEmail {
  from: string;
  to: string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments: File[];
  /**
   * Repeated headers arrive as an array, not a joined string — observed on
   * `received`, which came through as two entries. A bare
   * `Record<string, string>` is wrong and makes `.split()` on a value a
   * runtime TypeError.
   */
  headers: Record<string, string | string[]>;
}
