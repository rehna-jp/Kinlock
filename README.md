# KinLock

**A self-custodied crypto inheritance vault on Solana.** If you stop checking in, the people you chose can claim your funds with an emailed link and a passphrase. They need no wallet connection and no SOL for fees: they paste any Solana address and claim.

> **Devnet demo. Unaudited. Never use real funds.**

- **Live app:** [https://web-eta-seven-y6r4siobrz.vercel.app](https://web-eta-seven-y6r4siobrz.vercel.app/)
- **Demo video:** `<YOUR-VIDEO-URL>`
- **Program (devnet):** [`DnuvWPjfZhLE3mtFkM9frcpmhAYnfhnfarJTTvj6wDeD`](https://explorer.solana.com/address/DnuvWPjfZhLE3mtFkM9frcpmhAYnfhnfarJTTvj6wDeD?cluster=devnet)

## The problem

Crypto held in a self-custodied wallet is lost if its owner dies or loses access. Existing options are custodial services, or hand-built multisig and time-lock setups that families cannot use when they need them most.

## How it works

1. **Set up.** The owner creates a vault, picks a check-in interval and a grace period, and names up to two beneficiaries with percentage shares. They can add an optional guardian and choose to hold devnet USDC alongside SOL.
2. **Stay alive.** One tap on **check in** resets the clock. Nothing is emailed while the owner is active.
3. **Missed check-in.** After the interval passes, the owner (and guardian) get a warning email. This is the safeguard against a false trigger: checking in cancels everything.
4. **Guardian gate (optional).** The guardian can approve release. They cannot move funds. If they never respond, beneficiaries can claim after a timeout the owner chose.
5. **Claim.** When the grace period ends, each beneficiary is emailed a claim link. They enter the passphrase the owner gave them in person, paste any Solana address, and claim. A relayer pays the network fee.

KinLock never detects death. It detects **missed check-ins plus a grace period**, and warns the owner and guardian first.

## Why Solana

- Settlement in about a second and fees of a fraction of a cent make a gasless claim practical for a recipient who holds no SOL.
- The release rules live in a Solana program, not on a server: timestamps, the guardian gate, the share split and the lock after the first claim are all enforced on-chain.
- SPL tokens (USDC) are claimed in the same transaction as SOL.

## Features

- Vault holds SOL and optionally one SPL token (devnet USDC), fixed at creation
- Check-in interval and grace period, owner cancel or withdraw any time before a claim
- Up to two beneficiaries with exact basis-point shares, snapshotted at first claim so later claimants are not shorted
- Optional guardian with approval and a timeout fallback
- Beneficiary claim page: passphrase plus any destination address, no wallet connection and no SOL needed for fees
- Staged email notifications, each recipient tracked separately (no duplicates, one failure never blocks another)
- Live status dashboard with stage timeline and countdown

## Architecture

```
 Browser (Next.js)                     Server (Next.js API routes)               Solana devnet
 ─────────────────                     ───────────────────────────               ─────────────
 Owner dashboard  ── create vault ───────────────────────────────────────────▶  KinLock program
   generates claim keypairs                                                       (vault PDA, rules,
   encrypts secrets with passphrase ─▶ /api/register (owner-signed) ─▶ Supabase    SOL + USDC custody)
 Guardian page    ── approve ────────────────────────────────────────────────▶
 Claim page       ── decrypts in browser ─▶ /api/relay (pays fee) ───────────▶
                                       /api/claim-bundle (only once claimable)
                                       /api/watcher ◀── Supabase cron (every minute)
                                          └─ reads chain, sends email (Gmail SMTP or Resend)
```

## Security model

- **Claim keys.** For each beneficiary the browser generates a fresh keypair. The public key goes on-chain. The secret key is encrypted in the browser (PBKDF2-SHA256, 600k iterations, AES-256-GCM, bound to the public key) and only the encrypted bundle is stored off-chain. The server never sees a usable secret.
- **Passphrase.** Told to the beneficiary offline. A leaked email or link is useless without it.
- **Key bundle release.** The server returns the encrypted bundle only after the on-chain state says the vault is claimable.
- **Registration.** The owner signs a message bound to the exact payload. The server also checks the claim keys and shares against the on-chain vault.
- **Relayer.** It signs as fee payer only for a single well-formed `claim` instruction (optionally preceded by creating the destination USDC account), only for registered claim keys, and simulates before sending.
- **On-chain checks.** Share totals, duplicate keys, guardian not owner, destination not the vault, token account ownership and mint, double-claim and lock rules.

| Threat | Mitigation |
|---|---|
| Owner is just away, not gone | Warning emails first, guardian gate, check-in cancels everything |
| Leaked claim email | Needs the offline passphrase |
| Database leak | Only encrypted bundles stored; strong passphrases resist offline guessing |
| Relayer abuse | Instruction allowlist, registered keys only, rate limits, simulation |
| First claimant takes it all | Shares computed from a snapshot taken once, at the first claim |

## Known limitations

- Devnet only, unaudited, not for real funds.
- A short or weak passphrase combined with a leaked database allows offline guessing. The app requires 12+ characters.
- Email is a convenience layer. If it fails, the on-chain claim still works for anyone holding the link and passphrase, but notification does not happen.
- Emails sent from a brand-new Gmail account can land in spam. A verified domain with SPF, DKIM and DMARC would fix this.
- One vault per wallet, up to two beneficiaries, one token mint chosen at creation.
- A brand-new destination address needs at least about 0.001 SOL in its share (rent exemption).
- The beneficiary still needs a Solana address to receive funds. KinLock removes the wallet connection and the fee, not the need for somewhere to receive the money.
- The relayer's rate limit is in memory and per server instance.

## Repo layout

```
programs/kinlock/src/lib.rs   Anchor program
tests/kinlock.ts              Program tests (local validator)
web/                          Next.js app and API routes
  app/                        pages (owner, /guardian/[vault], /claim/[token]) and /api routes
  lib/                        shared helpers, browser crypto, idl.json
  supabase/schema.sql         database schema
```

## Getting started

**Prerequisites:** Rust, Solana CLI, Anchor, Node 20+, a Supabase project, a Gmail account with an app password (or a verified Resend domain), a browser wallet such as Solflare set to Devnet.

**1. Program**
```bash
anchor build
solana config set --url devnet
solana program deploy target/deploy/kinlock.so --program-id target/deploy/kinlock-keypair.json
cp target/idl/kinlock.json web/lib/idl.json
```

**2. Database.** Run `web/supabase/schema.sql` in the Supabase SQL editor.

**3. Relayer wallet.** Make a dedicated devnet wallet and fund it with a few devnet SOL:
```bash
solana-keygen new -o relayer.json --no-bip39-passphrase
solana-keygen pubkey relayer.json
```

**4. Environment.** Copy `web/.env.example` to `web/.env.local` and fill it in:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_RPC_URL`, `SOLANA_RPC_URL` | Devnet RPC (use a provider key for reliability) |
| `NEXT_PUBLIC_RELAYER_PUBKEY` | Relayer address |
| `RELAYER_SECRET_KEY` | Relayer secret key as a JSON array (server only) |
| `NEXT_PUBLIC_TOKEN_MINT` | Optional; defaults to Circle devnet USDC |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database (service key is server only) |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Sends email through Gmail |
| `RESEND_API_KEY`, `MAIL_FROM` | Optional alternative to Gmail (needs a verified domain) |
| `APP_URL` | Public URL used in email links |
| `CRON_SECRET` | Protects `/api/watcher` |

Never commit `.env.local` or any wallet keypair.

**5. Run**
```bash
cd web && npm install && npm run dev
```
For local email, also run `npm run watch` in a second terminal.

## Testing

```bash
anchor test
```
Runs the program suite on a local validator: share math, double-claim and stranger rejection, locking, guardian gate and timeout, check-in reset, owner withdraw and cancel, and the SOL + token claim paths.

End-to-end (manual): create a vault with the demo timers, miss a check-in, confirm the owner and guardian emails, approve as guardian, confirm the beneficiary email, and claim in a private window.

## Deploying

1. Push to GitHub and import the repo in Vercel with the root directory set to `web`. Add every variable above, with `APP_URL` set to the Vercel address, and make sure `web/lib/idl.json` is committed.
2. In Supabase enable `pg_cron` and `pg_net`, then schedule the watcher:
```sql
select cron.schedule('kinlock-watcher', '* * * * *', $$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/watcher',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET', 'Content-Type', 'application/json')
  ) $$);
```

## Demo mode

On the create-vault screen, **Fill demo timers** sets a 120 s check-in, 60 s grace period and 60 s guardian timeout so the full flow can be shown in a few minutes.

## Roadmap

- Security audit and mainnet readiness
- Passkey or embedded-wallet creation, so a recipient needs no existing wallet or address at all
- More than two beneficiaries and multiple tokens
- Reminder channels beyond email, with a verified sending domain
- Durable, distributed rate limiting for the relayer

Built for the Solana Hackathon (MLH).
