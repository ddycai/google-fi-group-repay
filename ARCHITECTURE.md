# Architecture

How google-fi-group-repay is put together and why. For the user-facing "how do I run it",
see [README.md](README.md).

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

Every link the email sends is this one shape:

```
https://venmo.com/payment-link?txn=charge&amount=34.60&note=Google%20Fi%20—%20August%202026&recipients=<a,b,c>
```

`username` is the Venmo @handle, not a display name. Verified working on iOS:
opens a Request screen with recipients, amount, and note prefilled.

#### Why `venmo.com` and not `account.venmo.com`

`venmo.com` is Venmo's universal-link domain; `account.venmo.com` is not.

| | Phone with the app | Desktop, or no app |
| --- | --- | --- |
| `venmo.com/payment-link?…` | iOS matches the domain **before any network request** and hands the URL to the app, which parses `recipients` itself | 302s to `account.venmo.com`, renders as a page |
| `account.venmo.com/payment-link?…` | Not a universal-link domain — opens a browser tab | Same |

Verified with curl under both a mobile and a desktop User-Agent. One URL is
correct everywhere, so there is no variant to select and no configuration knob.

Three near-misses, each of which cost a round of rework:

- **`account.venmo.com/payment-link`** is the end of that redirect chain.
  Linking it directly works, but skips the app handoff and always lands in a
  browser.
- **`venmo.com/<user>` in the path** resolves a single username. A phone makes
  a comma list *appear* to work, because the app intercepts before the request;
  ask a server and `venmo.com/a,b,c` 404s. The path form is a trap — it behaves
  differently depending on whether anything is listening, which is why curl is
  the wrong instrument for this question.
- **A `venmo://` deeplink** was tried and removed. Gmail drops the `href` for
  any scheme outside `http`/`https`/`mailto`/`ftp`, so it arrived as
  unclickable text. It is not needed: on a phone Venmo's own redirect chain
  ends at `venmo://paycharge` anyway, so an `https` link Gmail is happy to pass
  through still opens the app.

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

## Pipeline

```
Google Fi emails the statement (PDF attached)
        │
        ▼
Gmail filter forwards it to <val>@valtown.email
        │
        ▼
Val Town runs handleStatement(message)          src/val.ts
        │
        ├─ not from Fi?  ──────────────► dropped, never parsed
        ├─ Gmail forwarding confirmation? ─► relayed to the user
        │
        ▼
find the PDF attachment                          src/process.ts
        │
        ▼
extract text, read the per-member table          src/parse.ts
        │
        ▼
match names to config, validate the total        src/split.ts
        │
        ▼
build one charge URL per person                  src/links.ts
        │
        ▼
compare against last month, then store           src/history.ts, src/changes.ts
        │
        ▼
email the user one message, one button each      src/email-render.ts
        │
        ▼
user taps. Venmo opens prefilled. User confirms.
```

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
proportional tax allocation. It was deleted. Recomputing can only ever
*disagree* with the bill — in the observed August 2026 statement, a $12.75
service credit landed entirely on one person, which a proportional model would
have smeared across all five.

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

### Val Town, and therefore Deno

Val Town was chosen because its **email trigger provides an inbox address
without owning a domain**. The original plan was Cloudflare Email Routing, which
requires a domain the user does not have. Val Town's free tier also sends email
*only to the account owner*, which is exactly the delivery target.

Deno is not a design choice — it is what Val Town executes vals with. It leaks
into this project in exactly one place: Deno has no `node_modules` and needs npm
packages named explicitly, so `scripts/build-val.mjs` bundles `src/` with
esbuild and rewrites `from "unpdf"` to `from "npm:unpdf"`. The `esm.town` URL
imports and `unpdf` are left external for Deno to resolve at runtime.

`valtown/main.ts` is **generated**. Never edit it; run `npm run build:val`.

Because URL imports cannot resolve under `tsc`, `src/valtown.d.ts` declares
`https://esm.town/v/std/{email,blob}`, the `Deno` global, and `ValTownEmail`.

### `config.json` is the source of truth; `config.env` is generated from it

The val reads its roster from a `FI_GROUP_REPAY_CONFIG` environment variable, and Val
Town can bulk-import environment variables from a dotenv-format file. Rather
than maintain that file by hand — a second copy of the same handles, free to
drift — `npm run build:env` generates it from `config.json`.

It is named `config.env`, not `.env`, so it is visible in a file listing rather
than hidden. Nothing reads it locally; it exists only to be uploaded.

Two quoting decisions in `scripts/build-env.mjs` are deliberate:

- **The JSON is minified onto one line.** dotenv format has no agreed
  multi-line syntax, and a value broken across lines is the usual way one of
  these silently truncates.
- **The value is single-quoted**, so the JSON's own double quotes pass through
  untouched. There is no portable way to escape a single quote inside a
  single-quoted dotenv value, so a name containing an apostrophe throws with a
  message pointing at the Val Town UI instead. Currently no name has one.

The script also refuses to emit a config with placeholder handles still in it,
because that failure would otherwise surface as a Venmo request pointed at
nobody.

### I/O is injected so the monthly path is testable

`src/process.ts` holds the entire statement-to-email flow and takes all its I/O
as arguments — config, PDF parsing, history read/write, sending. `src/val.ts`
is nothing but adapters wiring Val Town's `blob`, `email`, and `Deno.env` into
those slots.

This exists because the alternative is discovering bugs once a month. The
sender gate, the repeat handling, the failure paths, and "a failed send must not
consume the month" are all covered by tests that never touch Val Town.

`src/val.ts` is the only untested file in the project, by design.

### History keeps exactly two statements

Blob key `fi-group-repay:statements` — the short name, deliberately. The repo
is `google-fi-group-repay`; the key, the `FI_GROUP_REPAY_*` environment
variables, and the local directory all kept the shorter one. Renaming them buys
nothing a searcher can see, and renaming the blob key specifically **orphans
the stored baseline**, so the next month reports as a first run with no change
detection. Don't "fix" the inconsistency.

Blobs are **account-scoped, not val-scoped**
— to inspect or delete one, use Settings → Blob Storage, not the Blob Storage
panel in the val's own sidebar, which does not show it. Keys are shared across
every val on the account, hence the prefix.

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

### There is no sender authentication beyond the allowlist, and there cannot be

The allowlist checks what `From:` *claims*. `From:` is a plain SMTP header, Val
Town's inbound mail is "powered internally by Sendgrid Inbound Parse", and
neither promises DMARC enforcement — so assume it is forgeable by anyone who
knows the trigger address.

A DKIM check was designed to replace it and **abandoned after inspecting a real
statement's headers**. Recorded here so it is not attempted again.

The complete inbound header list:

```
arc-authentication-results, arc-message-signature, arc-seal, content-type,
date, dkim-signature, from, in-reply-to, message-id, mime-version, received,
references, subject, to, x-gm-*, x-google-dkim-signature, x-received
```

There is no `Authentication-Results` header. The only candidate reads, in full:

```
arc-authentication-results: i=1; mx.google.com; arc=none
```

`arc=none` means "no prior ARC chain", not an authentication verdict. **No
dkim, spf, or dmarc result exists anywhere in the message.**

Verifying the signature in the val instead is also impossible, for two
independent reasons:

- The surviving `dkim-signature` is `d=gmail.com` (`darn=valtown.email`), plus
  `x-google-dkim-signature: d=1e100.net`. Google's original `d=google.com`
  signature is **stripped** — Gmail's auto-forward re-signs as the forwarding
  account. Repeated headers arrive as arrays and this one did not, so there is
  genuinely only one. The strongest provable claim would be "a Gmail account
  forwarded this", never "Google sent this".
- Val Town hands over a parsed object, not the raw signed bytes, so the
  canonicalisation a verifier needs is unavailable regardless.

**What would still work, unimplemented.** The last `Received` header is written
by `mx.sendgrid.net` itself, so a sender cannot forge it, and it names the
connecting host — `mail-oi1-f169.google.com` on a real run. Requiring a
Google-operated host authenticates the last relay rather than the author:
weaker than DKIM, but not forgeable from an attacker's own server.

**The fix that actually matters is not code.** The same header exposed the
trigger address, which had been named after the project and is therefore
guessable from a public repo. Every attack here starts with knowing that
address, so making it unguessable — a random token in the local part — buys
more than any header check would have. Do that instead.

**What the allowlist is not carrying.** Even forged, an attacker gets no charge
links to themselves: Venmo handles come from `config.json`, never from the
statement, and `computeShares` rejects any statement whose names do not match
the configured roster. The realistic exposure is failure-email spam, Val Town
quota, and an untrusted PDF reaching `unpdf`.

### Untrusted input is refused, not sanitised

Anyone who learns the `@valtown.email` trigger address can send to it. The
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

## Layout

| Path | Responsibility |
| --- | --- |
| `src/parse.ts` | PDF bytes → statement date, per-member amounts, total |
| `src/split.ts` | Match amounts to configured people; validate; `toCents`/`formatCents` |
| `src/links.ts` | Amounts → Venmo charge URLs, all three variants |
| `src/changes.ts` | Month-over-month diff, and the subject line |
| `src/history.ts` | The two-statement store and repeat detection |
| `src/email-render.ts` | The monthly email, HTML and text |
| `src/process.ts` | The whole flow, I/O injected |
| `src/val.ts` | Val Town adapters — env, blob, email. Untested by design |
| `src/valtown.d.ts` | Declarations for URL imports and the `Deno` global |
| `scripts/build-val.mjs` | esbuild bundle + the `npm:` rewrite |
| `scripts/build-env.mjs` | `config.json` → `config.env` for Val Town import |
| `valtown/main.ts` | Generated. Deploy this. Do not edit |
| `config.example.env` | The shape `config.env` takes. Committed; `.env` last so editors read it as dotenv |
| `config.env` | Generated. Import this. Do not edit |

Dependencies: `unpdf` (PDF text, works in Deno and Node), plus esbuild, tsx,
typescript as dev tooling.

`config.json` and any `.eml`/`.pdf` are gitignored; they hold real handles,
amounts, and a home address.

## Known gaps

- **Deployed and working as of August 2026.** The Val Town glue is confirmed:
  the email trigger, `blob`, `email`, and `npm:unpdf` all resolve, and a real
  statement produced correct grouped links. Two bugs surfaced on first deploy —
  deploying `src/val.ts` instead of the bundle, and passing `html: ""` where Val
  Town requires the field absent. Both are fixed and covered by tests.
- **The monthly path has only run on a hand-forwarded copy.** Change detection
  has never run against a real stored baseline (the first run had none), and no
  statement has yet arrived through Gmail's automatic forwarding with Fi's own
  `From:` header. September's statement is the first true unattended run.
- **The parser has seen one real statement** (August 2026). Its assumptions
  about layout rest on that single sample plus defensive checks. A statement
  with a different structure should fail loudly rather than mis-parse, but that
  has not been observed.
- **The Venmo link format is undocumented** and has broken before. Verified by
  hand on iOS, not by anything automated.
- **Third-party exposure.** Val Town sees the statement PDF, which carries a
  home address and phone number, and the configured Venmo handles. Accepted
  deliberately as the cost of an unattended monthly run.

## Changing common things

- **Someone joins or leaves the plan** — edit `config.json`, then
  `npm run build:env` and re-import `config.env` on the val. The run fails until
  both match the statement.
- **A Venmo handle changes** — same: edit `config.json`, rebuild, re-import.
- **Deploying a code change** — `npm run build:val`, then push or paste
  `valtown/main.ts`.
- **Venmo breaks prefilled links** — check the two alternate forms in the
  output first. If all three are dead, switch `links.ts` for a Splitwise
  `createExpense` call; everything upstream is unaffected.
