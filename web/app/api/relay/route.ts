import { NextRequest, NextResponse } from "next/server";
import { PublicKey, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "@/lib/idl.json";
import { PROGRAM_ID, TOKEN_MINT } from "@/lib/shared";
import { connection, relayer } from "@/lib/server/chain";
import { db } from "@/lib/server/db";

// Gasless relayer: signs as fee payer ONLY for
//   [claim]                                   (SOL only)
//   [create ATA idempotent, claim]            (SOL + USDC; relayer pays the ATA rent)
const CLAIM_DISC = Buffer.from(
  (idl as { instructions: { name: string; discriminator: number[] }[] }).instructions.find((i) => i.name === "claim")!.discriminator
);

const hits = new Map<string, number[]>(); // in-memory; use Upstash/Redis if you deploy serverless at scale
function limited(key: string, max: number) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
    if (limited(`ip:${ip}`, 10)) return bad("Too many requests", 429);

    const { tx: b64 } = await req.json();
    if (typeof b64 !== "string" || b64.length > 4000) return bad("Bad request");
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    const kp = relayer();
    const mint = new PublicKey(TOKEN_MINT);

    if (!tx.feePayer?.equals(kp.publicKey)) return bad("Invalid fee payer");
    const ixs = tx.instructions;
    if (ixs.length < 1 || ixs.length > 2) return bad("Unexpected instructions");

    if (ixs.length === 2) {
      const a = ixs[0];
      if (!a.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || a.data.length !== 1 || a.data[0] !== 1) return bad("Unexpected instruction");
      if (a.keys.length !== 6 || !a.keys[0].pubkey.equals(kp.publicKey) || !a.keys[3].pubkey.equals(mint) || !a.keys[5].pubkey.equals(TOKEN_PROGRAM_ID)) return bad("Unexpected token account setup");
      if (!a.keys[1].pubkey.equals(getAssociatedTokenAddressSync(mint, a.keys[2].pubkey, true))) return bad("Unexpected token account");
    }

    const ix = ixs[ixs.length - 1];
    if (!ix.programId.equals(PROGRAM_ID)) return bad("Wrong program");
    if (ix.data.length !== 8 || !ix.data.equals(CLAIM_DISC)) return bad("Not a claim instruction");
    if (ix.keys.length !== (ixs.length === 2 ? 7 : 4) || !ix.keys[2].pubkey.equals(kp.publicKey)) return bad("Unexpected accounts");

    const claimant = ix.keys[1].pubkey;
    const signed = tx.signatures.find((s) => s.publicKey.equals(claimant))?.signature;
    if (!ix.keys[1].isSigner || !signed || !tx.verifySignatures(false)) return bad("Missing or invalid claimant signature", 401);

    // Only keys registered by a real vault owner may use the relayer
    const { data: ben } = await db.from("beneficiaries").select("token").eq("claim_key", claimant.toBase58()).maybeSingle();
    if (!ben) return bad("Unknown claim key", 403);
    if (limited(`key:${claimant.toBase58()}`, 5)) return bad("Too many requests", 429);

    tx.partialSign(kp);
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      const reason = (sim.value.logs ?? []).reverse().find((l) => l.includes("Error Message")) ?? JSON.stringify(sim.value.err);
      return bad(`Claim would fail: ${reason}`, 422);
    }
    const signature = await connection.sendRawTransaction(tx.serialize());
    return NextResponse.json({ signature });
  } catch (e) {
    console.error("relay", e);
    return bad("Relay failed", 500);
  }
}
