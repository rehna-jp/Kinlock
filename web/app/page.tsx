"use client";
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, getMint,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { WalletButton } from "@/components/WalletButton";
import Timeline from "@/components/Timeline";
import { useProgram } from "@/lib/useProgram";
import { TOKEN_MINT, computeStatus, parseVault, vaultPda, VaultView } from "@/lib/shared";
import { b64, encryptSecret, sha256Hex } from "@/lib/crypto";

const UNIT = { seconds: 1, minutes: 60, days: 86400 } as const;
type Unit = keyof typeof UNIT;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Ben = { name: string; email: string; pct: string; pass: string };
const emptyBen = (): Ben => ({ name: "", email: "", pct: "", pass: "" });
const fmt = (s: number) => {
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m ${s % 60}s` : `${m}m ${s % 60}s`;
};
const LABEL: Record<string, string> = {
  active: "Active", grace: "Grace period", awaiting_guardian: "Guardian review", claimable: "Open to claim", claimed: "Claimed",
};
const ZERO = BigInt(0);

const WORDS = [
  "amber", "anchor", "beacon", "breeze", "cedar", "cipher", "cobalt", "coral",
  "crystal", "dawn", "echo", "falcon", "fossil", "glacier", "harbor", "haven",
  "island", "jasper", "kinetic", "lagoon", "lantern", "lunar", "meadow", "mosaic",
  "nebula", "oasis", "orbit", "prism", "quartz", "radius", "ripple", "sable",
  "shadow", "silver", "solace", "summit", "timber", "trail", "valley", "velvet"
];
function generatePassphrase(): string {
  const chosen: string[] = [];
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 4; i++) chosen.push(WORDS[bytes[i] % WORDS.length]);
  return chosen.join("-");
}

export default function Owner() {
  const { program, wallet, connection } = useProgram();
  const { sendTransaction, signMessage } = useWallet();
  const [vault, setVault] = useState<VaultView | null>(null);
  const [balance, setBalance] = useState(0);
  const [tok, setTok] = useState<{ decimals: number; raw: bigint } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [amt, setAmt] = useState("");
  const [tAmt, setTAmt] = useState("");
  const [useToken, setUseToken] = useState(true);
  const [step, setStep] = useState(1);
  const [started, setStarted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [f, setF] = useState({ ownerName: "", ownerEmail: "", unit: "days" as Unit, interval: "30", grace: "14", gKey: "", gEmail: "", gTimeout: "14" });
  const [bens, setBens] = useState<Ben[]>([{ ...emptyBen(), pct: "100" }]);
  const [showPass, setShowPass] = useState<Record<number, boolean>>({});
  const [copied, setCopied] = useState<Record<number, boolean>>({});
  const pk = wallet?.publicKey;
  const pkStr = pk?.toBase58();
  const pendingKey = `kinlock-pending-${pkStr}`;

  const refresh = useCallback(async () => {
    if (!program || !pk) { setVault(null); setLoaded(false); return; }
    const p = vaultPda(pk);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = await (program.account as any).vault.fetchNullable(p);
    const parsed = acc ? parseVault(acc) : null;
    setVault(parsed);
    setLoaded(true);
    setBalance(await connection.getBalance(p));
    if (parsed?.mint) {
      const m = new PublicKey(parsed.mint);
      const { decimals } = await getMint(connection, m);
      let raw = ZERO;
      try { raw = BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(m, p, true))).value.amount); } catch { /* ATA not created yet */ }
      setTok({ decimals, raw });
    } else setTok(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, pkStr, connection]);

  useEffect(() => { refresh().catch(() => {}); const t = setInterval(() => refresh().catch(() => {}), 5000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (pkStr) setPending(localStorage.getItem(pendingKey)); }, [pkStr, pendingKey]);

  async function register(json: string) {
    if (!pk || !signMessage) throw new Error("This wallet cannot sign messages. Use Phantom or Solflare.");
    const ts = Date.now();
    const sig = await signMessage(new TextEncoder().encode(`KinLock register ${vaultPda(pk).toBase58()} ${ts} ${await sha256Hex(json)}`));
    const r = await fetch("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: pk.toBase58(), ts, json, signature: b64(sig) }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Registration failed");
    localStorage.removeItem(pendingKey);
    setPending(null);
  }

  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setMsg("");
    try { const m = await fn(); if (m) setMsg(m); await refresh(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  const create = () => run(async () => {
    if (!program || !pk) throw new Error("Connect your wallet first.");
    const mult = UNIT[f.unit];
    const interval = Math.round(+f.interval * mult), grace = Math.round(+f.grace * mult), gTimeout = Math.round(+f.gTimeout * mult);
    if (!(interval > 0) || !(grace >= 0) || !(gTimeout >= 0)) { setStep(1); throw new Error("Enter valid timing values."); }
    if (!f.ownerName.trim() || !EMAIL.test(f.ownerEmail)) { setStep(1); throw new Error("Enter your name and a valid email."); }
    const guardian = f.gKey.trim() ? new PublicKey(f.gKey.trim()) : null;
    if (guardian && !EMAIL.test(f.gEmail)) { setStep(2); throw new Error("Enter the guardian email."); }
    const shares = bens.map((b) => Math.round(parseFloat(b.pct) * 100));
    if (shares.some((s) => !(s > 0)) || shares.reduce((a, b) => a + b, 0) !== 10000) throw new Error("Shares must be positive and total 100%.");
    for (const b of bens) {
      if (!b.name.trim() || !EMAIL.test(b.email)) throw new Error("Each beneficiary needs a name and a valid email.");
      if (b.pass.length < 12) throw new Error("Each passphrase needs at least 12 characters. Use several random words.");
    }

    setMsg("Encrypting claim keys (a few seconds)...");
    const prepared = await Promise.all(bens.map(async (b, i) => {
      const kp = Keypair.generate();
      return { b, kp, shareBps: shares[i], blob: await encryptSecret(kp.secretKey, b.pass, kp.publicKey.toBase58()) };
    }));

    const m = new PublicKey(TOKEN_MINT);
    const v = vaultPda(pk);
    const initIx = await program.methods
      .initializeVault(new BN(interval), new BN(grace), guardian, new BN(gTimeout), useToken ? m : null, prepared.map((p) => ({ claimKey: p.kp.publicKey, shareBps: p.shareBps })))
      .accountsPartial({ vault: v, owner: pk, systemProgram: SystemProgram.programId })
      .instruction();

    const tx = new Transaction().add(initIx);
    if (useToken) {
      tx.add(createAssociatedTokenAccountIdempotentInstruction(pk, getAssociatedTokenAddressSync(m, v, true), v, m));
    }
    const sig = await sendTransaction(tx, connection);
    await connection.confirmTransaction(sig, "confirmed");

    const json = JSON.stringify({
      ownerName: f.ownerName.trim(), ownerEmail: f.ownerEmail.trim(), guardianEmail: guardian ? f.gEmail.trim() : null,
      beneficiaries: prepared.map((p) => ({ name: p.b.name.trim(), email: p.b.email.trim(), claimKey: p.kp.publicKey.toBase58(), shareBps: p.shareBps, blob: p.blob })),
    });
    localStorage.setItem(pendingKey, json);
    setPending(json);
    await register(json);
    setBens([{ ...emptyBen(), pct: "100" }]);
    return "Vault created. Now tell each beneficiary their passphrase in person (never by email), and fund the vault.";
  });

  const lamports = () => { const n = Math.round(+amt * LAMPORTS_PER_SOL); if (!(n > 0)) throw new Error("Enter an amount in SOL."); return n; };
  const rawTokens = () => { const n = BigInt(Math.round(+tAmt * 10 ** tok!.decimals)); if (!(n > ZERO)) throw new Error("Enter an amount in USDC."); return n; };

  // Instructions to move tokens from the vault back to the owner's token account
  async function withdrawTokenIxs(raw: bigint) {
    const m = new PublicKey(vault!.mint!), v = vaultPda(pk!);
    const ownerAta = getAssociatedTokenAddressSync(m, pk!);
    const ix = await program!.methods.ownerWithdrawToken(new BN(raw.toString()))
      .accountsPartial({ vault: v, owner: pk!, mint: m, vaultToken: getAssociatedTokenAddressSync(m, v, true), ownerToken: ownerAta, tokenProgram: TOKEN_PROGRAM_ID })
      .instruction();
    return [createAssociatedTokenAccountIdempotentInstruction(pk!, ownerAta, pk!, m), ix];
  }

  const status = vault ? computeStatus(vault, now) : null;
  const due = vault ? vault.lastCheckIn + vault.interval : 0;
  const setBen = (i: number, k: keyof Ben, v: string) => setBens(bens.map((b, j) => (j === i ? { ...b, [k]: v } : b)));

  let headline = "", big = "", pct = 0;
  if (vault && status) {
    const open = due + vault.grace;
    if (status === "active") { headline = "Next check-in due in"; big = fmt(due - now); pct = ((now - vault.lastCheckIn) / vault.interval) * 100; }
    else if (status === "grace") { headline = "Beneficiaries can claim in"; big = fmt(open - now); pct = vault.grace > 0 ? ((now - due) / vault.grace) * 100 : 100; }
    else if (status === "awaiting_guardian") { headline = "Waiting for your guardian"; big = "On hold"; pct = 100; }
    else if (status === "claimable") { headline = "Beneficiaries can claim"; big = "Now"; pct = 100; }
    else { headline = "Every share has been claimed"; big = "Done"; pct = 100; }
    pct = Math.max(0, Math.min(100, pct));
  }

  return (
    <main className="wrap">
      {(!pk || (loaded && !vault && !started)) && (
        <>
          <section className="hero">
            <span className="eyebrow">Crypto inheritance, on Solana</span>
            <h1>If you vanish,<br />your crypto <em>shouldn’t.</em></h1>
            <p className="lede">KinLock passes your SOL and USDC to the people you choose when you stop checking in. They claim with a link and a passphrase, with no wallet to connect and no SOL needed for fees.</p>
            <div className="cta">{pk ? <button className="btn" onClick={() => setStarted(true)}>Create your vault</button> : <><WalletButton /><span className="muted small">Connect a devnet wallet to start</span></>}</div>
          </section>
          <section className="steps3">
            <div className="step"><b>01</b><strong>Set it up</strong><p>Pick a check-in rhythm and who inherits. Each claim key is locked with a passphrase, in your browser.</p></div>
            <div className="step"><b>02</b><strong>Stay alive</strong><p>One tap resets the clock. Miss it and you, then your guardian, are warned first.</p></div>
            <div className="step"><b>03</b><strong>They claim</strong><p>After the grace period, beneficiaries get an email and claim with the passphrase you gave them. Fees are covered.</p></div>
          </section>
          <div className="strip"><span>Settles in about a second</span><span>Costs a fraction of a cent</span><span>Self-custodied</span><span>Passphrase never leaves the browser</span></div>
        </>
      )}

      {msg && <div className={`note ${/created|checked|deposited|withdrawn|closed|registered|approved/i.test(msg) ? "ok" : ""}`} role="status">{msg}</div>}

      {pending && (
        <div className="note">
          Your vault exists on-chain but email registration is incomplete. Beneficiaries will not be notified until it is.
          <div><button className="btn" disabled={busy} onClick={() => run(async () => { await register(pending); return "Registered."; })}>Retry registration</button></div>
        </div>
      )}

      {pk && !loaded && <p className="muted" style={{ marginTop: 28 }}>Loading your vault…</p>}

      {pk && loaded && !vault && started && (
        <section className="card" style={{ marginTop: 28 }}>
          <button className="btn ghost" style={{ margin: 0, float: "right" }} onClick={() => setStarted(false)}>Home</button>
          <h2>Create your vault</h2>
          <p className="muted" style={{ marginTop: 0 }}>Three quick steps. Nothing is sent until the last one.</p>
          <div className="wiz" aria-hidden="true">{[1, 2, 3].map((n) => <span key={n} className={step >= n ? "on" : ""} />)}</div>

          {step === 1 && (
            <>
              <h3>1 · You and your timing</h3>
              <div className="grid3">
                <label className="field"><span>Your name</span><input value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></label>
                <label className="field"><span>Your email</span><input type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></label>
              </div>
              <div className="grid3">
                <label className="field"><span>Unit</span><select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value as Unit })}>{Object.keys(UNIT).map((u) => <option key={u}>{u}</option>)}</select></label>
                <label className="field"><span>Check in every</span><input inputMode="decimal" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })} /></label>
                <label className="field"><span>Then a grace period of</span><input inputMode="decimal" value={f.grace} onChange={(e) => setF({ ...f, grace: e.target.value })} /></label>
              </div>
              <label className="check"><input type="checkbox" checked={useToken} onChange={(e) => setUseToken(e.target.checked)} /> Also hold USDC (devnet) in this vault</label>
              <div className="row-actions">
                <button className="btn" onClick={() => setStep(2)}>Next</button>
                <button className="btn ghost" onClick={() => setF({ ...f, unit: "seconds", interval: "120", grace: "60", gTimeout: "60" })}>Fill demo timers</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h3>2 · Guardian (optional)</h3>
              <p className="muted small">A trusted person who is warned first and must approve before funds release. They can never move your money.</p>
              <div className="grid3">
                <label className="field"><span>Guardian wallet address</span><input value={f.gKey} onChange={(e) => setF({ ...f, gKey: e.target.value })} /></label>
                <label className="field"><span>Guardian email</span><input type="email" value={f.gEmail} onChange={(e) => setF({ ...f, gEmail: e.target.value })} /></label>
                <label className="field"><span>Release anyway after</span><input inputMode="decimal" value={f.gTimeout} onChange={(e) => setF({ ...f, gTimeout: e.target.value })} /></label>
              </div>
              <p className="muted small">If the guardian never responds, beneficiaries can claim once this extra time passes after the grace period (same unit as step 1).</p>
              <div className="row-actions">
                <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
                <button className="btn" onClick={() => setStep(3)}>{f.gKey.trim() ? "Next" : "Skip"}</button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h3>3 · Who inherits</h3>
              {bens.map((b, i) => (
                <div className="sub" key={i}>
                  <div className="grid3">
                    <label className="field"><span>Name</span><input value={b.name} onChange={(e) => setBen(i, "name", e.target.value)} /></label>
                    <label className="field"><span>Email</span><input type="email" value={b.email} onChange={(e) => setBen(i, "email", e.target.value)} /></label>
                    <label className="field"><span>Share %</span><input inputMode="decimal" value={b.pct} onChange={(e) => setBen(i, "pct", e.target.value)} /></label>
                  </div>
                  <label className="field">
                    <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>Passphrase (12+ characters, tell them in person)</span>
                      <span style={{ display: "flex", gap: "10px" }}>
                        <button
                          type="button"
                          style={{ background: "none", border: "none", color: "var(--lime)", cursor: "pointer", fontSize: "0.78rem", padding: 0 }}
                          onClick={() => setBen(i, "pass", generatePassphrase())}
                        >
                          🎲 Generate
                        </button>
                        {b.pass && (
                          <button
                            type="button"
                            style={{ background: "none", border: "none", color: "var(--mint)", cursor: "pointer", fontSize: "0.78rem", padding: 0 }}
                            onClick={() => {
                              navigator.clipboard.writeText(b.pass);
                              setCopied((prev) => ({ ...prev, [i]: true }));
                              setTimeout(() => setCopied((prev) => ({ ...prev, [i]: false })), 2000);
                            }}
                          >
                            {copied[i] ? "✓ Copied" : "Copy"}
                          </button>
                        )}
                        <button
                          type="button"
                          style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: "0.78rem", padding: 0 }}
                          onClick={() => setShowPass((prev) => ({ ...prev, [i]: !prev[i] }))}
                        >
                          {showPass[i] ? "Hide" : "Show"}
                        </button>
                      </span>
                    </span>
                    <input
                      type={showPass[i] ? "text" : "password"}
                      autoComplete="new-password"
                      value={b.pass}
                      placeholder="e.g. glacier-solace-amber-beacon"
                      onChange={(e) => setBen(i, "pass", e.target.value)}
                    />
                    {b.pass && b.pass.length < 12 && (
                      <span style={{ color: "var(--coral)", fontSize: "0.75rem", display: "block", marginTop: "4px" }}>
                        Needs at least 12 characters ({b.pass.length}/12)
                      </span>
                    )}
                  </label>
                </div>
              ))}
              <div className="row-actions">
                <button className="btn ghost" onClick={() => setStep(2)}>Back</button>
                {bens.length < 2 && <button className="btn ghost" onClick={() => setBens([{ ...bens[0], pct: "50" }, { ...emptyBen(), pct: "50" }])}>Add second beneficiary</button>}
                {bens.length === 2 && <button className="btn ghost" onClick={() => setBens([{ ...bens[0], pct: "100" }])}>Remove second</button>}
                <button className="btn" disabled={busy} onClick={create}>{busy ? "Working..." : "Create vault"}</button>
              </div>
            </>
          )}
        </section>
      )}

      {pk && vault && status && (
        <>
          <section className="panel" data-s={status}>
            <div className="panel-top">
              <span className="badge">{LABEL[status]}</span>
              <span className="muted small mono">{pkStr!.slice(0, 4)}…{pkStr!.slice(-4)}</span>
            </div>
            <Timeline status={status} guardian={!!vault.guardian} />
            <div className="count-label">{headline}</div>
            <div className="count-value mono">{big}</div>
            <div className="bar"><i style={{ width: `${pct}%` }} /></div>
            <div className="row-actions">
              <button className="btn" disabled={busy || vault.locked} onClick={() => run(async () => { await program!.methods.checkIn().accountsPartial({ vault: vaultPda(pk), owner: pk }).rpc(); return "Checked in."; })}>I am alive · check in</button>
              <button className="btn danger" disabled={busy || vault.locked} onClick={() => confirm("Close the vault and return all funds?") && run(async () => {
                const pre = tok && tok.raw > ZERO ? await withdrawTokenIxs(tok.raw) : [];
                await program!.methods.cancelVault().accountsPartial({ vault: vaultPda(pk), owner: pk }).preInstructions(pre).rpc();
                return "Vault closed. Funds returned.";
              })}>Cancel vault</button>
            </div>
          </section>

          <section className="grid2">
            <div className="card">
              <h3>SOL in vault</h3>
              <div className="big mono">{(balance / LAMPORTS_PER_SOL).toFixed(4)} <small>SOL</small></div>
              <label className="field"><span>Amount (SOL)</span><input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} /></label>
              <div className="row-actions">
                <button className="btn" disabled={busy || vault.locked} onClick={() => run(async () => {
                  const sig = await sendTransaction(new Transaction().add(SystemProgram.transfer({ fromPubkey: pk, toPubkey: vaultPda(pk), lamports: lamports() })), connection);
                  await connection.confirmTransaction(sig, "confirmed"); return "Deposited.";
                })}>Deposit</button>
                <button className="btn ghost" disabled={busy || vault.locked} onClick={() => run(async () => { await program!.methods.ownerWithdraw(new BN(lamports())).accountsPartial({ vault: vaultPda(pk), owner: pk }).rpc(); return "Withdrawn."; })}>Withdraw</button>
              </div>
            </div>

            {vault.mint && tok && (
              <div className="card">
                <h3>USDC in vault</h3>
                <div className="big mono">{(Number(tok.raw) / 10 ** tok.decimals).toFixed(2)} <small>USDC</small></div>
                <label className="field"><span>Amount (USDC)</span><input inputMode="decimal" value={tAmt} onChange={(e) => setTAmt(e.target.value)} /></label>
                <div className="row-actions">
                  <button className="btn" disabled={busy || vault.locked} onClick={() => run(async () => {
                    const m = new PublicKey(vault.mint!), v = vaultPda(pk), vAta = getAssociatedTokenAddressSync(m, v, true);
                    const tx = new Transaction().add(
                      createAssociatedTokenAccountIdempotentInstruction(pk, vAta, v, m),
                      createTransferCheckedInstruction(getAssociatedTokenAddressSync(m, pk), m, vAta, pk, rawTokens(), tok.decimals)
                    );
                    const sig = await sendTransaction(tx, connection);
                    await connection.confirmTransaction(sig, "confirmed"); return "Deposited.";
                  })}>Deposit USDC</button>
                  <button className="btn ghost" disabled={busy || vault.locked} onClick={() => run(async () => {
                    const sig = await sendTransaction(new Transaction().add(...(await withdrawTokenIxs(rawTokens()))), connection);
                    await connection.confirmTransaction(sig, "confirmed"); return "Withdrawn.";
                  })}>Withdraw USDC</button>
                </div>
                <p className="muted small">Need test USDC? Get devnet USDC at faucet.circle.com (choose Solana, Devnet).</p>
              </div>
            )}

            <div className="card">
              <h3>Who inherits</h3>
              {vault.beneficiaries.map((b) => (
                <div className="list-row" key={b.claimKey}>
                  <span className="mono">{b.claimKey.slice(0, 6)}…{b.claimKey.slice(-4)}</span>
                  <span><b>{b.shareBps / 100}%</b>{b.claimed && <span className="tag ok">claimed</span>}</span>
                </div>
              ))}
              {vault.guardian && (
                <div className="list-row">
                  <span>Guardian <span className="mono muted">{vault.guardian.slice(0, 4)}…{vault.guardian.slice(-4)}</span></span>
                  <span>{vault.guardianApproved ? <span className="tag ok">approved</span> : <span className="tag">not yet</span>}</span>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
