"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import Timeline from "@/components/Timeline";
import { useProgram } from "@/lib/useProgram";
import { computeStatus, parseVault, VaultView } from "@/lib/shared";

export default function Guardian() {
  const { vault: addr } = useParams<{ vault: string }>();
  const { program, wallet } = useProgram();
  const [v, setV] = useState<VaultView | null>(null);
  const [msg, setMsg] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const refresh = useCallback(async () => {
    if (!program) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = await (program.account as any).vault.fetchNullable(new PublicKey(addr));
    setV(acc ? parseVault(acc) : null);
  }, [program, addr]);
  useEffect(() => { refresh().catch((e) => setMsg(e.message)); }, [refresh]);
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);

  const isGuardian = !!v && !!wallet && v.guardian === wallet.publicKey.toBase58();
  const expired = !!v && now > v.lastCheckIn + v.interval;
  const status = v ? computeStatus(v, now) : null;

  return (
    <main className="wrap narrow">
      <section className="hero" style={{ paddingBottom: 8 }}>
        <span className="eyebrow">Guardian</span>
        <h1 style={{ fontSize: "clamp(2.2rem,7vw,3.6rem)" }}>A friend needs <em>your call.</em></h1>
        <p className="lede">You were named guardian of a KinLock vault. You can approve its release, but you can never move the funds. Connect the guardian wallet to continue.</p>
      </section>
      {msg && <div className={`note ${/approved/i.test(msg) ? "ok" : ""}`}>{msg}</div>}
      {wallet && !v && <div className="note">Vault not found.</div>}
      {v && status && (
        <section className="panel" data-s={status}>
          <Timeline status={status} guardian={!!v.guardian} />
          {!isGuardian && <div className="note" style={{ marginTop: 22 }}>Connect the guardian wallet named in this vault.</div>}
          {isGuardian && !expired && <p className="count-label">The owner has not missed a check-in. Nothing to approve.</p>}
          {isGuardian && expired && !v.guardianApproved && (
            <>
              <p className="count-label">Try to reach the owner first. Approving lets their beneficiaries claim once the grace period ends.</p>
              <button className="btn" onClick={async () => { try { await program!.methods.guardianApprove().accountsPartial({ vault: new PublicKey(addr), guardian: wallet!.publicKey }).rpc(); setMsg("Approved."); await refresh(); } catch (e) { setMsg((e as Error).message); } }}>Approve release</button>
            </>
          )}
          {v.guardianApproved && <p className="count-label">You approved this release.</p>}
        </section>
      )}
    </main>
  );
}
