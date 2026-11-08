"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Program, Idl } from "@coral-xyz/anchor";
import idl from "@/lib/idl.json";
import { Blob, b64, decryptSecret } from "@/lib/crypto";

type Bundle = { ownerName: string; name: string; vault: string; claimKey: string; shareBps: number; status: string; mint: string | null; blob: Blob | null };
const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const NOTE: Record<string, string> = {
  active: "The owner is still checking in. There is nothing to claim.",
  grace: "The owner missed a check-in. Their grace period has not ended yet.",
  awaiting_guardian: "Waiting for the owner’s guardian to approve. This page will unlock once they do, or after their timeout.",
  claimed: "This share has already been claimed.",
};

export default function Claim() {
  const { token } = useParams<{ token: string }>();
  const [b, setB] = useState<Bundle | null>(null);
  const [err, setErr] = useState("");
  const [pass, setPass] = useState("");
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [showPass, setShowPass] = useState(false);

  const isValidDest = (() => {
    const t = dest.trim();
    if (!t) return null;
    try {
      new PublicKey(t);
      return true;
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    fetch(`/api/claim-bundle?token=${encodeURIComponent(token)}`)
      .then(async (r) => (r.ok ? setB(await r.json()) : setErr((await r.json()).error ?? "Not found")))
      .catch(() => setErr("Could not load this page."));
  }, [token]);

  async function claim() {
    if (!b?.blob) return;
    setBusy(true); setErr("");
    try {
      const relayerPk = new PublicKey(process.env.NEXT_PUBLIC_RELAYER_PUBKEY!);
      const destination = new PublicKey(dest.trim());
      const kp = Keypair.fromSecretKey(await decryptSecret(b.blob, pass, b.claimKey));
      if (kp.publicKey.toBase58() !== b.claimKey) throw new Error("Key bundle mismatch");

      const connection = new Connection(RPC, "confirmed");
      const program = new Program(idl as Idl, { connection });
      const vaultPk = new PublicKey(b.vault);
      const builder = program.methods.claim()
        .accountsPartial({ vault: vaultPk, claimant: kp.publicKey, feePayer: relayerPk, destination });
      const ixs: TransactionInstruction[] = [];
      if (b.mint) {
        const mint = new PublicKey(b.mint);
        const vaultAta = getAssociatedTokenAddressSync(mint, vaultPk, true);
        const destAta = getAssociatedTokenAddressSync(mint, destination, true);
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(relayerPk, vaultAta, vaultPk, mint));
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(relayerPk, destAta, destination, mint));
        builder.remainingAccounts([
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: destAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ]);
      }
      ixs.push(await builder.instruction());

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: relayerPk, blockhash, lastValidBlockHeight }).add(...ixs);
      tx.partialSign(kp);

      const r = await fetch("/api/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: b64(tx.serialize({ requireAllSignatures: false })) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Relay failed");
      await connection.confirmTransaction({ signature: j.signature, blockhash, lastValidBlockHeight }, "confirmed");
      setDone(j.signature);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <main className="wrap narrow">
      {err && <div className="note" role="alert" style={{ marginTop: 28 }}>{err}</div>}
      {b && (
        <>
          <section className="claimhero">
            <span className="eyebrow">A message for {b.name}</span>
            <h1 style={{ fontSize: "clamp(2rem,6.5vw,3.2rem)", marginBottom: 8 }}>{b.ownerName} left this <em>for you.</em></h1>
            <div className="share mono">{b.shareBps / 100}%</div>
            <p className="muted">of their KinLock vault{b.mint ? " (SOL and USDC)" : ""}</p>
          </section>

          {NOTE[b.status] && <div className="note">{NOTE[b.status]}</div>}

          {b.status === "claimable" && !done && (
            <section className="card">
              <h3>Claim in two steps</h3>
              <label className="field">
                <span style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>1 · The passphrase {b.ownerName} gave you</span>
                  <button type="button" style={{ background: "none", border: "none", color: "var(--lime)", cursor: "pointer", fontSize: "0.78rem", padding: 0 }} onClick={() => setShowPass(!showPass)}>
                    {showPass ? "Hide" : "Show"}
                  </button>
                </span>
                <input type={showPass ? "text" : "password"} autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Enter the 12+ char passphrase" />
              </label>
              <label className="field">
                <span style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>2 · A Solana address to receive the funds</span>
                  {isValidDest === true && <span style={{ color: "var(--mint)", fontSize: "0.78rem" }}>✓ Valid Solana address</span>}
                  {isValidDest === false && <span style={{ color: "var(--coral)", fontSize: "0.78rem" }}>✗ Invalid address</span>}
                </span>
                <input
                  value={dest}
                  onChange={(e) => setDest(e.target.value)}
                  placeholder="Paste any Solana address"
                  style={{ borderColor: isValidDest === true ? "var(--mint)" : isValidDest === false ? "var(--coral)" : undefined }}
                />
              </label>
              <p className="muted small">You do not need any SOL to claim, and you do not connect a wallet. Paste an address you control, for example one from Solflare or Phantom. For a brand-new address, the SOL share must be at least about 0.001 SOL.</p>
              <button className="btn" disabled={busy || !pass || isValidDest !== true} onClick={claim}>{busy ? "Claiming..." : "Claim my share"}</button>
            </section>
          )}

          {done && (
            <div className="note ok">
              Claimed. The funds are on their way to your address.{" "}
              <a href={`https://explorer.solana.com/tx/${done}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction</a>
            </div>
          )}
        </>
      )}
    </main>
  );
}
