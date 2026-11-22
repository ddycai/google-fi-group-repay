# Architecture

How google-fi-group-repay is put together and why. For the user-facing "how do I run it",
see [README.md](README.md).

## Vercel and Resend

The Node.js 22 entry point is `POST /api/resend`. Resend delivers an
`email.received` event after Gmail forwards the statement. The adapter verifies
the raw request using the Resend signing secret and Svix headers, checks the
destination, and retrieves the message through the authenticated Resend API.
For accepted statement senders, it fetches attachment metadata and passes lazy
download functions to the existing `processStatement` flow. Downloads use
HTTPS without redirects and enforce a 10 MiB PDF limit. Gmail forwarding
confirmations take the existing text relay path.

Webhook verification authenticates the provider's request. The email sender
allowlist is a separate application check on the email's `From:` header.
Keep the receiving address private and use a random local part. Provider
responses, signed download URLs, and PDFs stay out of application logs. Resend
manages its own inbound retention.

| Path | Responsibility |
| --- | --- |
| `api/resend.ts` | Vercel entry point |
| `src/resend-webhook.ts` | Verify events, retrieve statements, and send email |
| `src/delivery.ts` | Stage delivery, retry with a stable key, and finalize history |
| `src/blob-store.ts` | Read and conditionally update the private state document |
| `scripts/statement-state.ts` | Inspect state and reconcile pending mail |

### Delivery and history

`processStatement` still owns PDF parsing, bill validation, Venmo URL generation,
and comparison with the last two statements. In the Vercel adapter, its send
and save callbacks stage the outbound message and next history in memory.

The private Blob at `fi-group-repay/state.json` stores the current history,
completed Resend email IDs, and at most one staged delivery. Reads bypass the
Blob cache. Conditional writes use the current ETag to claim the next delivery
and finalize it, so concurrent statements cannot overwrite each other's
history. Initial creation disallows overwriting an existing state. Completed
IDs are retained for the life of the state document so old provider replays
remain distinguishable from new forwarded emails.

After claiming a delivery, the handler sends the saved message using the Resend
email ID as the basis for its idempotency key. It then commits the new history
and records the ID as complete in one write. If that write fails, the next
invocation retries the same message and key before finalizing. A separate
forwarded email has a different ID and can still send a summary marked
`(repeat)` when its printed statement date matches the history.

Transient retrieval, outbound, and storage failures return a retryable status.
An invalid statement stages a single failure alert without advancing history.
If a pending delivery reaches 23 hours, automatic sends pause because Resend's
idempotency keys expire after 24 hours. Operators reconcile against Resend's
sending records using the commands in the README. An unresolved pending event
also prevents subsequent statements from advancing history.

References:
[Resend inbound email](https://resend.com/features/inbound),
[Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys),
[Vercel Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk).

## The constraint everything else follows from

**There is no legitimate way to send a Venmo request programmatically.**

Venmo's official Developer API has been closed to new signups since around 2016
— their docs state that only businesses granted access "generally prior to
2016" retain it, and everything published today is merchant payment acceptance
via Braintree. There is no endpoint for charging another user.

An unofficial API exists ([`mmohades/Venmo`](https://github.com/mmohades/Venmo))
which impersonates the iOS app and can genuinely send requests unattended. It
was rejected:

- It violates Venmo's terms on an account that holds money.
- Authentication mints a **never-expiring** access token equivalent to full
  account control, including moving funds out.
- Its repository has unresolved 401/403 authentication issues dating to 2024,
  with no meaningful maintenance since.

So the design goal is not "automate the Venmo request." It is **automate
everything up to the request, and make the request one tap.** Every month the
user taps one button per person. That is not a limitation to be engineered
around later; it is the shape of the problem.

The fallback, if Venmo ever breaks prefilled links, is the
[Splitwise API](https://dev.splitwise.com/) — official, personal API key,
`createExpense` with exact amounts. Researched and held in reserve.

### Venmo charge links

Two forms, chosen by how many people a link charges:

| Charging | Link | On a phone |
| --- | --- | --- |
| One person | `venmo.com/<user>?txn=charge&amount=…&note=…` | Opens the Venmo app |
| Several | `account.venmo.com/payment-link?txn=charge&amount=…&note=…&recipients=a,b,c` | Opens in the browser |

`<user>` is the Venmo @handle, not a display name. Both open a Request screen
with recipients, amount, and note prefilled.

A group card's button uses the browser form, and offers the same request one
person at a time beneath it — those per-person links are the app form, so a
group still has an in-app route, just not in one tap.

**Settled on a real phone, after several wrong turns.** Do not "simplify" to
one form:

- **`venmo.com/payment-link?…`** looks like the best of both — `venmo.com` for
  the app handoff, `payment-link` for the list. On a real phone it sends the
  browser and the app into an **endless redirect loop**. This was the shipped
  form for one month, chosen on the strength of a single successful test and
  `curl` traces; the September statement is what exposed it.
- **`venmo.com/a,b,c`** resolves a single username only and 404s on a list.
- **A `venmo://` deeplink** is stripped by Gmail, which drops the `href` on any
  scheme outside `http`/`https`/`mailto`/`ftp`. It is not needed: on a phone,
  Venmo's own redirect from `venmo.com/<user>` ends at `venmo://` anyway.

`curl` is the wrong instrument for all of this. It cannot observe the iOS
universal-link handoff or the app's side of a redirect, which is exactly where
every one of these forms succeeds or fails. Only a phone settles it.

#### One amount per link

`recipients` takes **comma-separated usernames** and opens a separate request
for each, but there is only one `amount` parameter — so a single link can only
charge people who owe the *same* amount. `groupCharges` buckets by amount for
this reason. Most months every share is identical and it collapses to one tap;
the months it doesn't are the ones where Fi put a credit or a device payment on
one line.

Encoding detail: usernames are escaped individually and joined with a literal
comma. Escaping the joined list turns the separator into `%2C` and Venmo reads
the result as one very long username.

Venmo **silently drops** a recipient it cannot resolve rather than erroring — a
mixed valid/invalid list still returns 200. A typo'd handle means that person
quietly goes uncharged.

Grouped links are the least documented part of this, so a group card also
offers the same request one person at a time. A single-person card carries no
fallback row, because it is already that fallback.

**Venmo Groups cannot be used.** Group expenses are added manually in the app;
there is no link, API, or import to drive them.

## Decisions

### Google Fi's numbers are used verbatim

Page 2 of the statement PDF carries a per-member table:

```
Ada Byron            $34.60
Sample Owner         $61.25
Alan Turing          $18.35
Grace Murray         $34.60
Rosalind Franklin    $34.60
Total               $183.40
```

These are **final** amounts. Fi has already allocated taxes, regulatory fees,
device payments, and one-off credits per person, and they sum exactly to the
total.

An earlier version reconstructed each share from line charges plus a
proportional tax allocation. That approach could spread a member’s service
credit across the whole plan. The parser now uses the amount Fi prints for
each member.

Consequences that look like bugs but are not: a device payment sits entirely on
its owner's line, and a one-off credit lands entirely on whoever received it.

### The PDF is parsed, not the email body

The statement email is `multipart/mixed` → [`multipart/alternative` (text/plain
+ text/html), `application/pdf`]. **The body carries only the total** ("Your
total is $183.40") plus a link. The per-member breakdown exists only in the
attachment. Parsing the body would have been simpler and does not work.

### The table parser walks backwards

`src/parse.ts` anchors on the table's trailing bare `Total` / amount pair and
walks backwards in name/amount pairs.

This avoids ever having to recognise where the table *starts*. Directly above it
sits a summary row, `Total $183.40`, on a single line. The amount regex is
anchored (`^...$`) so that line does not match as an amount cell, which is what
stops the walk. **Do not loosen `AMOUNT_LINE` to match amounts anywhere in a
line** — the walk would run up into the summary rows and start charging people
called "Device payment".

It also means the parser doesn't care how many people are on the plan.

### Mismatches fail; they are never guessed at

Two independent checks, both fatal:

1. `parse.ts` — the per-member amounts must sum to the table's own printed total.
2. `split.ts` — every name on the statement must exist in `config.json`, every
   person in config must appear on the statement, and the amounts must sum to
   the stated total.

The second check is also the defence against a doctored PDF: a forged statement
would have to name exactly the configured people with amounts summing correctly.

It also means **adding someone to the Fi plan will break the run until
`config.json` is updated**. That is intentional. The alternative is silently
not charging the new person.

### Roster and history

`npm run build:env` refreshes the roster and sender allowlist in `.env.vercel`
from `config.json`. It preserves other saved values. Upload the configuration
with `npm run vercel:env` and deploy for the changes to take effect.

The only question being asked is "is anything
different from last month", so a long history was unnecessary and was removed.

**It is two rather than one deliberately.** A forwarded email can easily arrive
twice. With a single slot, the repeat would find its own statement stored and
have nothing left to compare against — reporting "no changes" even when there
were some. Statements are keyed by their printed date, so a repeat is detected,
labelled `(repeat)` in the subject, and leaves the stored baseline untouched.

Do not "simplify" this to one slot.

### History is saved after the email is sent

If sending fails, the month is not consumed — a retry still sees the correct
baseline and still sends. Ordering matters here.

### Untrusted input is refused, not sanitised

Anyone who learns the Resend receiving address can send to it. The
sender allowlist (`FI_GROUP_REPAY_ALLOWED_SENDERS`, from `allowedSenders` in
`config.json`, default `payments-noreply@google.com`) rejects unknown senders
**before** the PDF is parsed, so an untrusted attachment never reaches the
parser.

**Which address arrives depends on how the mail is forwarded.** Gmail's
automatic forwarding preserves Fi's `From:`, so the default allowlist works.
Pressing **Forward** on a message replaces it with your own address, which the
allowlist then rejects — observed in testing. Adding your own address fixes it
but widens the gate, and manual forwarding also defeats the point of the
automation. Auto-forwarding is the intended setup.

The allowlist is not the only defence. A doctored PDF would still have to name
exactly the configured people with amounts summing to the printed total, and
the user reviews every amount before tapping anything.

One deliberate exception: Gmail will not forward to a new address until you
confirm a code it sends *to that address*, which the allowlist would otherwise
drop, making setup impossible. `processStatement` recognises
`forwarding-noreply@google.com` and relays that message verbatim as text. It is
never parsed or acted on — it exists so a human can read a code out of it.

### Money is integer cents everywhere

Dollars are converted at the boundary (`toCents`) and everything internal is
integer cents. Amounts are compared in cents, so float noise never registers as
a change.

## Current repository layout

| Path | Responsibility |
| --- | --- |
| `src/parse.ts` | PDF bytes → statement date, per-member amounts, total |
| `src/split.ts` | Match amounts to configured people; validate; `toCents`/`formatCents` |
| `src/links.ts` | Amounts → Venmo charge URLs, all three variants |
| `src/changes.ts` | Month-over-month diff, and the subject line |
| `src/history.ts` | The two-statement store and repeat detection |
| `src/email-render.ts` | The monthly email, HTML and text |
| `src/process.ts` | The whole flow, I/O injected |
| `scripts/build-env.mjs` | Generate the Vercel environment file from the roster |
| `scripts/update-vercel-env.mjs` | Upload populated variables to Vercel Production |
