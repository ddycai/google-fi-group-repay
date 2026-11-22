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

## Vercel and Resend setup

Use one Vercel project, private Blob store, and Resend webhook for testing and
monthly bills. Going live means switching the Gmail forwarding filter.

### 1. Prepare your bill roster

Run these commands from the local checkout that contains `package.json` and
`vercel.json`.

```bash
npm install
cp -n config.example.json config.json
```

Edit `config.json`:

- Match each person's name exactly as it appears on the Fi statement.
- Give the bill payer `"isOwner": true` and enter the other members' Venmo handles.
- In `allowedSenders`, keep `payments-noreply@google.com`. Replace the sample
  email with the address you'll use to **manually forward** the test bill.
  If you only use automatic forwarding, remove the sample email.

### 2. Link your Vercel project

```bash
npx vercel login
npx vercel link
```

| CLI prompt | What to choose |
| --- | --- |
| Account or scope | Your personal account |
| Project | Link your existing project, or create `google-fi-repay` |
| Code directory | `./` if you ran the CLI from the checkout |
| Customize settings? | **No** |
| Connect this Git repository? | **No** to deploy manually from your Mac |

**No framework detected** is expected. `vercel.json` sets the framework preset,
and `package.json` specifies Node.js 22. The CLI deploys the local files,
including uncommitted changes.

### 3. Connect a private Blob store

1. In the project's Vercel dashboard, go to **Storage → Create Storage →
   Blob → Continue**.
2. Choose **Private**, name the store `google-fi-repay-blob`, and click
   **Create**. Vercel connects it automatically when you start inside the project.
3. Under **Settings → Environment Variables**, check that `BLOB_STORE_ID` is
   available in **Production**. Keep the default variable names.

If you created the store from your account's Storage page, open the store's
**Projects** tab and connect it to your project. Include **Production**.
The deployed function uses Vercel's built-in authentication. A read-write token
is only needed when you run the history tools from your Mac.

### 4. Get a Resend address and API key

1. Open [Resend → Emails → Receiving](https://resend.com/emails/receiving).
   Click **⋯ → Inbound address** to find your built-in `*.resend.app` domain.
2. Pick a unique name before the `@`. If your domain were `abc123.resend.app`,
   your receiving address could be `fi-k8m2@abc123.resend.app`. You can use that
   address immediately as `FI_GROUP_REPAY_INBOUND`.
3. In [Resend → API Keys](https://resend.com/api-keys), create a key with
   receiving and sending access. Copy it for `RESEND_API_KEY`.

For a test without a custom domain, use `onboarding@resend.dev` as
`FI_GROUP_REPAY_FROM` and **your Resend account email** as `FI_GROUP_REPAY_TO`.
That account email receives summaries and alerts. The `@…resend.app` address
is where you forward the bills.

### 5. Create the webhook and copy its signing secret

Find your project's stable `.vercel.app` address under **Settings →
Domains**. If you don't have a URL yet, run `npx vercel deploy --prod` from
your linked checkout to create the first deployment. Here `--prod` targets
the linked project's **Production** environment. You'll configure its email processing in step 6.

1. Open [Resend → Webhooks](https://resend.com/webhooks) and click
   **Add Webhook**.
2. Enter the project's stable URL plus `/api/resend`, for example
   `https://google-fi-repay.vercel.app/api/resend`. Resend must be able
   to reach that URL without a Vercel login.
3. Select **`email.received`** and save. Open the new webhook's details and
   copy its **Signing Secret**. You'll use this as `RESEND_WEBHOOK_SECRET`
   in step 6. It is separate from the API key.

### 6. Upload the environment variables and deploy

Generate the local env file:

```bash
npm run build:env
nano .env.vercel
```

`build:env` creates or updates `.env.vercel`. It refreshes the roster
and sender allowlist from `config.json` and preserves your saved settings
and secrets. Fill in any blanks for the inbound address, destination email,
API key, and webhook signing secret from steps 4 and 5.

```dotenv
FI_GROUP_REPAY_INBOUND=fi-k8m2@abc123.resend.app
FI_GROUP_REPAY_FROM=onboarding@resend.dev
FI_GROUP_REPAY_TO=your-resend-account-email@example.com
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
```

Run this from the linked checkout to upload the file. It adds or replaces
nonempty values in the project's **Production** environment. The file is
ignored by Git and excluded from the deployment upload.

```bash
npm run vercel:env
```

You can also paste the file's completed entries together under
**Settings → Environment Variables** in Vercel. Select **Production**.

```bash
npx vercel deploy --prod
```

### 7. Test one bill

Manually forward your most recent Fi statement with the PDF attached from an
address in `allowedSenders` to your Resend address. Check the amounts and Venmo
links in the summary. The first bill establishes the baseline. Forwarding the
same statement again should produce a summary marked `(repeat)`.

### 8. Set up Gmail forwarding

1. In Gmail, go to **Settings → Forwarding and POP/IMAP → Add a forwarding
   address** and enter the same Resend address you just tested. The app relays
   Google's verification message to `FI_GROUP_REPAY_TO`.
2. Create or edit a Gmail filter to forward to that address. Keep one active
   forwarding destination for this query:

   ```text
   from:payments-noreply@google.com subject:"Google Fi monthly statement"
   ```

3. Check that the first automatically forwarded statement produces a summary.

### If a delivery is stuck

After 23 hours the app pauses automatic resends for an unresolved delivery.
To inspect state from your Mac, open the Blob store’s **Projects** tab and edit
the project connection. Temporarily uncheck **Sensitive** for
`BLOB_READ_WRITE_TOKEN` and save. Type the first command below in Terminal.
Before pressing Return, copy the token value from Vercel.

```zsh
export BLOB_READ_WRITE_TOKEN="$(pbpaste)"
env -u BLOB_STORE_ID npm run statement-state -- status
```

Check the sending records in Resend for the pending email.
After 24 hours, use the command that matches what you confirmed:

| Resend outcome | Command |
| --- | --- |
| Resend accepted the send | `env -u BLOB_STORE_ID npm run statement-state -- confirm-sent <email-id>` |
| Resend did not accept the send | `env -u BLOB_STORE_ID npm run statement-state -- confirm-unsent <email-id>`, then replay the inbound event in Resend |

When finished, run `unset BLOB_READ_WRITE_TOKEN` and re-enable **Sensitive**.
Review and replay any other events that failed during that time. See
[the Vercel architecture](ARCHITECTURE.md#vercel-and-resend) for details.

## What it does each month

- **Ignores anything not from Fi.** Anyone who learns the trigger address can
  send to it, so unknown senders are dropped _before_ the PDF is parsed.
- **Flags anything that moved.** Amounts are usually identical month to month,
  so the subject line calls out changes — a device payment ending, a one-off
  credit. A double-forwarded email is marked `(repeat)` and leaves the baseline
  alone.
- **Fails loudly.** Any error emails you the reason. A silent failure would
  mean a month of nobody being charged.

Vercel stores the last two parsed statements in a private Blob.

## Privacy

Resend receives the forwarded PDF and delivers the summary. Vercel processes
the PDF and stores parsed history, delivery state, and configuration. Raw
PDFs are not written to Blob. Resend manages its own email and attachment retention. Summary emails go only to the configured owner,
and no money moves without you tapping a button in the Venmo app.

## Development

```bash
npm test
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
| `api/resend.ts` | Vercel webhook endpoint |
| `src/resend-webhook.ts` | Resend signature, receiving, and sending adapters |
| `src/delivery.ts`, `src/blob-store.ts` | Private history and retry recovery |
| `scripts/statement-state.ts` | Inspect state and reconcile deliveries |
For why any of it is shaped this way, see [ARCHITECTURE.md](ARCHITECTURE.md).

Built with [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE)
