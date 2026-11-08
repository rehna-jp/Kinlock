import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import crypto from "crypto";
import { db } from "@/lib/server/db";
import { fetchVault } from "@/lib/server/chain";
import { vaultPda } from "@/lib/shared";
import { PBKDF2_ITER } from "@/lib/crypto";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const B64 = /^[A-Za-z0-9+/=]{1,400}$/;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
const str = (x: unknown, max: number) => typeof x === "string" && x.trim().length > 0 && x.length <= max;

export async function POST(req: NextRequest) {
  try {
    const { owner, ts, json, signature } = await req.json();
    if (typeof json !== "string" || json.length > 20_000 || typeof signature !== "string") return bad("Bad request");
    const ownerPk = new PublicKey(owner);
    const vaultAddr = vaultPda(ownerPk).toBase58();

    // Owner must sign a message bound to this exact payload (prevents tampering and replay with other data)
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) return bad("Request expired");
    const hash = crypto.createHash("sha256").update(json).digest("hex");
    const msg = new TextEncoder().encode(`KinLock register ${vaultAddr} ${ts} ${hash}`);
    if (!nacl.sign.detached.verify(msg, Buffer.from(signature, "base64"), ownerPk.toBytes())) return bad("Bad signature", 401);

    const p = JSON.parse(json);
    if (!str(p.ownerName, 80) || !EMAIL.test(p.ownerEmail ?? "")) return bad("Invalid owner details");
    if (!Array.isArray(p.beneficiaries) || p.beneficiaries.length < 1 || p.beneficiaries.length > 2) return bad("Invalid beneficiaries");
    for (const b of p.beneficiaries) {
      const k = b?.blob;
      if (!str(b.name, 80) || !EMAIL.test(b.email ?? "") || !str(b.claimKey, 50) || !Number.isInteger(b.shareBps)) return bad("Invalid beneficiary");
      if (!k || k.v !== 1 || k.iter !== PBKDF2_ITER || !B64.test(k.salt) || !B64.test(k.iv) || !B64.test(k.ct)) return bad("Invalid key bundle");
    }

    // The on-chain vault is the source of truth
    const v = await fetchVault(vaultAddr);
    if (!v || v.owner !== ownerPk.toBase58()) return bad("Vault not found on-chain");
    const key = (x: { claimKey: string; shareBps: number }) => `${x.claimKey}:${x.shareBps}`;
    if (v.beneficiaries.map(key).sort().join() !== p.beneficiaries.map(key).sort().join()) return bad("Beneficiaries do not match the on-chain vault");
    if (v.guardian && !EMAIL.test(p.guardianEmail ?? "")) return bad("Guardian email required");

    const { error: e1 } = await db.from("vaults").upsert({
      vault: vaultAddr,
      owner: v.owner,
      owner_name: p.ownerName.trim(),
      owner_email: p.ownerEmail,
      guardian: v.guardian,
      guardian_email: v.guardian ? p.guardianEmail : null,
      warned_for: null,
    });
    if (e1) throw e1;
    await db.from("beneficiaries").delete().eq("vault", vaultAddr);
    const { error: e2 } = await db.from("beneficiaries").insert(
      p.beneficiaries.map((b: { name: string; email: string; claimKey: string; shareBps: number; blob: unknown }) => ({
        token: crypto.randomBytes(24).toString("base64url"),
        vault: vaultAddr,
        name: b.name.trim(),
        email: b.email,
        claim_key: b.claimKey,
        share_bps: b.shareBps,
        blob: b.blob,
        notified_for: null,
      }))
    );
    if (e2) throw e2;
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("register", e);
    return bad("Registration failed", 500);
  }
}
