export interface Person {
  /** Must match the name exactly as it appears on the Google Fi statement. */
  name: string;
  /** Venmo @handle, without the leading @. Omit for the bill payer. */
  venmo?: string;
  /** The person who pays Google Fi and collects from everyone else. Exactly one. */
  isOwner?: boolean;
}

export interface Config {
  people: Person[];
  /** Venmo note. `{month}` is replaced with the bill's month. */
  noteTemplate: string;
}

export interface Bill {
  /** Free text, e.g. "August 2026". Used in the Venmo note. */
  month: string;
  /**
   * Person name -> what they owe, in dollars, taken straight from the
   * per-member table on page 2 of the Fi statement. Fi has already allocated
   * taxes, fees, device payments, and credits, so these are final amounts.
   */
  people: Record<string, number>;
  /** Bill total in dollars. When present, the amounts must sum to it. */
  total?: number;
}

export interface Share {
  name: string;
  venmo?: string;
  isOwner: boolean;
  totalCents: number;
}
