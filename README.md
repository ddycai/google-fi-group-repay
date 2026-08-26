# google-fi-group-repay

**Automatically split your Google Fi bill and request the money back on Venmo —
every month.**

Google Fi used to do this for you. [Group Repay][gr] launched in June 2017:
Fi calculated each member's share, sent them a repayment notification, and they
tapped **Send Money** to pay you back. It has since been removed. Today the
statement arrives, and working out who owes what — then chasing five people for
it — is back to being your job.

This project puts that back together with the pieces that still exist:

```
Fi emails your statement  →  amounts read off the PDF  →  one email lands in
your inbox with a prefilled Venmo request per person  →  you tap them
```

Set it up once. Every month after that, the email arrives on its own.

[gr]: https://blog.google/products-and-platforms/products/project-fi/project-fi-group-repay/

## What you get, every month

An email like this, the morning your statement arrives:

> **Google Fi August 2026 — $183.40**
> Bill $183.40 · collecting $122.15 · your share $61.25
>
> **Ada, Grace and Rosalind** — $34.60 each → **[ Request $34.60 ]**
> **Alan Turing** — $18.35 → **[ Request $18.35 ]**

Each button opens Venmo with the recipients, the amount, and the note
("Google Fi — August 2026") already filled in. You confirm; Venmo sends the
request. People who owe the same amount are bundled into a single button — a
Venmo link takes several recipients but only one amount — so a typical month is
**one tap for the whole plan**.

(The exact URL format, and the three near-identical Venmo links that *don't*
work, are in [ARCHITECTURE.md](ARCHITECTURE.md#venmo-charge-links).)

### The one thing that isn't automatic

**The final tap is yours, by design.** Venmo has no public API for requesting
money from another person — it has been closed to new signups since roughly 2016. Unofficial libraries exist that impersonate the mobile app, but using one
means handing a never-expiring, full-control token to a script that can move
money out of your account. This project won't do that.

So it automates everything up to the request and makes the request one tap.
That is the honest shape of the problem, not a limitation waiting to be fixed.

### How it compares to Group Repay

|                             | Group Repay (retired) | google-fi-group-repay             |
| --------------------------- | --------------------- | --------------------------------- |
| Works out each share        | Automatic             | Automatic — uses Fi's own numbers |
| Reminds you the bill is due | Automatic             | Automatic — email on arrival      |
| Sends the payment request   | Automatic             | **One tap per amount**            |
| Member pays                 | Tap the notification  | Tap the Venmo request             |
| Runs on                     | Google Wallet         | Venmo                             |

## The amounts come straight from Fi

Fi has already done the split. Page 2 of the statement PDF carries a per-member
table:

```
Ada Byron            $34.60
Sample Owner         $61.25
Alan Turing          $18.35
Grace Murray         $34.60
Rosalind Franklin    $34.60
Total               $183.40
```

Those are **final** amounts — taxes, regulatory fees, device payments, and
credits are already allocated per person. This project charges exactly these
and recomputes nothing, so it can never disagree with your bill.

Two things that look like bugs but aren't: a device payment sits entirely on
its owner's line, and a one-off credit lands entirely on whoever received it.

If the per-person amounts don't sum to the printed total, the run **fails**
rather than guessing. Same if someone on the statement isn't in your config —
better a loud failure than quietly not charging the new roommate.

## Setup

You'll need a [Val Town](https://val.town) account (free tier is enough) and
Gmail. Budget about fifteen minutes, once.

Val Town is used for one specific reason: its email trigger gives you an inbox
address **without owning a domain**, and its free tier can send email to
yourself. That combination is what makes an unattended monthly run possible at
zero cost.

### 1. Configure your plan

```bash
git clone https://github.com/ddycai/google-fi-group-repay.git
cd google-fi-group-repay
npm install
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "people": [
    { "name": "Your Name", "isOwner": true },
    { "name": "Friend One", "venmo": "friend-one-handle" },
    { "name": "Friend Two", "venmo": "friend-two-handle" }
  ],
  "noteTemplate": "Google Fi — {month}",
  "allowedSenders": ["payments-noreply@google.com", "your-email@example.com"]
}
```

- `name` must match the Fi statement **exactly**. A mismatch fails the run
  instead of silently dropping someone.
- `venmo` is the @handle from their Venmo profile, **not** their display name.
  Venmo silently ignores a recipient it can't resolve, so a typo here means
  that person just doesn't get charged.
- Whoever pays Google Fi gets `"isOwner": true` and no `venmo` — they're
  excluded from the charge list.
- `allowedSenders` is who the val accepts statements from. Anything from
  anyone else is dropped **before** the PDF is parsed. See
  [below](#who-the-val-accepts-mail-from) for what to put here.

`config.json` is gitignored. It holds real handles.

#### Who the val accepts mail from

Two addresses matter, and which you need depends on how the statement gets
there:

| How you forward | `From:` the val sees | Needs in `allowedSenders` |
| --- | --- | --- |
| Gmail auto-forwarding *(recommended)* | `payments-noreply@google.com` — Fi's own | `payments-noreply@google.com` |
| Pressing **Forward** by hand | **your** address | your address too |

Automatic forwarding preserves Fi's address in `From:`. Pressing **Forward**
creates a new message from you, so the val sees your address and rejects it
unless you have listed yourself.

The example ships `your-email@example.com` in the second slot so the option is
visible. **Replace it with your own address, or delete the entry** if you only
ever auto-forward — `npm run build:env` refuses to generate anything while the
placeholder is still there, so you cannot ship it to a live val by accident.

(`example.com` is reserved by RFC 2606 and can never be registered, so the
placeholder is inert even if the guard is bypassed by setting the environment
variables by hand in Val Town's UI.)

Listing your own address is a genuine trade, not just convenience:

- It lets you forward a statement by hand — useful for testing, for a month
  Gmail's filter missed, or before you have auto-forwarding set up.
- It widens the gate. `From:` is a plain header and nothing here verifies it
  cryptographically (see [ARCHITECTURE.md](ARCHITECTURE.md)), so every address
  you list is one more that an attacker who knows your trigger address can
  claim to be.

Hand-forwarding also defeats the point of the automation, since you have to
remember to do it. Use it to get set up, then rely on the filter.

### 2. Deploy the val

```bash
npm run build:val    # bundles src/ into valtown/main.ts
```

Create a val at [val.town](https://val.town), give it an **Email** trigger, and
paste in **`valtown/main.ts`**:

```bash
pbcopy < valtown/main.ts        # macOS
```

> Deploy the bundle, not `src/val.ts`. The source file's relative imports don't
> exist on Val Town and it fails at runtime with `ERR_MODULE_NOT_FOUND`. The
> bundle has every module inlined.

### 3. Upload your config

```bash
npm run build:env    # writes config.env from config.json
```

In the val's **Environment variables**, import `config.env`. It sets
`FI_GROUP_REPAY_CONFIG` and `FI_GROUP_REPAY_ALLOWED_SENDERS`.

`config.json` stays the source of truth — after changing a handle or the
roster, re-run `build:env` and re-import rather than editing the variables by
hand.

### 4. Point Gmail at it

Copy the val's `@valtown.email` trigger address, then in Gmail:

1. **Settings → Forwarding and POP/IMAP → Add a forwarding address**, paste it.
2. Gmail emails a confirmation code to that address. **The val will relay that
   code to you** — it recognises the message and forwards it, so you can finish
   the step. (Otherwise the code would land where nobody can read it.)
3. Create a filter on
   `from:payments-noreply@google.com subject:"Google Fi monthly statement"`
   with **Forward it to** set to that address, so only the statement goes.

> Use Gmail's automatic forwarding, not the **Forward** button. Auto-forwarding
> preserves Fi's address in `From:`, which is what the sender allowlist checks
> — and it means never having to remember, which is the entire point. Pressing
> **Forward** sends the statement as *you*, so it only works if your own
> address is in [`allowedSenders`](#who-the-val-accepts-mail-from).

That's it. Next statement, the email arrives by itself.

## What it does each month

- **Ignores anything not from Fi.** Anyone who learns the trigger address can
  send to it, so unknown senders are dropped _before_ the PDF is parsed.
- **Flags anything that moved.** Amounts are usually identical month to month,
  so the subject line calls out changes — a device payment ending, a one-off
  credit. A double-forwarded email is marked `(repeat)` and leaves the baseline
  alone.
- **Fails loudly.** Any error emails you the reason. A silent failure would
  mean a month of nobody being charged.

The last two statements are kept in Val Town blob storage under
`fi-group-repay:statements` — just enough to answer "did anything change?"

## Troubleshooting

| Symptom                 | Cause                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| No email arrived        | Check the Gmail filter fired, and the val's logs                        |
| "missing from config"   | Someone joined the plan — add them to `config.json`, rebuild, re-import |
| Statement was rejected  | Forwarded by hand? The `From:` is now yours, not Fi's                   |
| A person wasn't charged | Venmo couldn't resolve their handle — check it on their profile         |
| `ERR_MODULE_NOT_FOUND`  | `src/val.ts` was deployed instead of `valtown/main.ts`                  |

## Privacy

Val Town sees your statement PDF — which carries a home address and phone
number — and the Venmo handles you configure. That's the cost of an unattended
monthly run; decide if it's acceptable to you. Nothing is sent to anyone else,
and no money moves without you tapping a button in the Venmo app.

## Development

```bash
npm test         # no Val Town runtime needed
npm run typecheck
```

| Path                  | Role                                                   |
| --------------------- | ------------------------------------------------------ |
| `src/parse.ts`        | PDF → per-member amounts                               |
| `src/split.ts`        | Match amounts to configured people, validate the total |
| `src/links.ts`        | Amounts → Venmo charge URLs                            |
| `src/changes.ts`      | Month-over-month diff and the subject line             |
| `src/history.ts`      | Two-statement store, repeat detection                  |
| `src/email-render.ts` | The monthly email                                      |
| `src/process.ts`      | The whole flow, all I/O injected                       |
| `src/val.ts`          | Val Town adapters — env, blob, email                   |
| `valtown/main.ts`     | Generated. Deploy this. Don't edit it                  |

`src/process.ts` takes its I/O as arguments, so the monthly path is fully
tested without a Val Town runtime — the alternative is finding bugs once a
month.

For why any of it is shaped this way, see [ARCHITECTURE.md](ARCHITECTURE.md).

Built with [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE)
