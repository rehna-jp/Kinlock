import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createMint, mintTo, getAccount, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import { Kinlock } from "../target/types/kinlock";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Kinlock as Program<Kinlock>;
const conn = provider.connection;
const me = provider.wallet.publicKey;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chainNow = async () => Number((await conn.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32));
// The local validator's clock only advances with transactions, so wait by sending tiny transfers.
async function waitChain(secs: number) {
  const t = (await chainNow()) + secs; const t0 = Date.now(); let n = 1;
  while ((await chainNow()) < t) {
    if (Date.now() - t0 > 60000) throw new Error("chain clock stalled at " + (await chainNow()) + ", target " + t);
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: me, toPubkey: me, lamports: n++ })));
  }
}
const pdaOf = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), o.toBuffer()], program.programId)[0];

async function fund(kp: Keypair, sol = 2) {
  const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}
async function fails(p: Promise<unknown>, code: string) {
  try { await p; } catch (e) { assert.include(String(e), code, `wrong error: ${e}`); return; }
  assert.fail(`expected failure with ${code}`);
}

type Opts = { interval?: number; grace?: number; guardian?: Keypair | null; gTimeout?: number; shares?: number[]; mint?: PublicKey | null };

async function setup(o: Opts = {}) {
  const { interval = 2, grace = 1, guardian = null, gTimeout = 0, shares = [10000], mint = null } = o;
  const owner = Keypair.generate();
  await fund(owner);
  const claimants = shares.map(() => Keypair.generate());
  const vault = pdaOf(owner.publicKey);
  await program.methods
    .initializeVault(new BN(interval), new BN(grace), guardian ? guardian.publicKey : null, new BN(gTimeout), mint,
      claimants.map((c, i) => ({ claimKey: c.publicKey, shareBps: shares[i] })))
    .accountsPartial({ vault, owner: owner.publicKey, systemProgram: SystemProgram.programId })
    .signers([owner]).rpc();
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: me, toPubkey: vault, lamports: LAMPORTS_PER_SOL })));
  return { owner, claimants, vault };
}

async function setupToken(shares = [7000, 3000]) {
  const payer = (provider.wallet as anchor.Wallet).payer;
  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  const s = await setup({ shares, mint });
  const vaultAta = getAssociatedTokenAddressSync(mint, s.vault, true);
  await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(me, vaultAta, s.vault, mint)));
  await mintTo(conn, payer, mint, vaultAta, payer, 1_000_000_000n); // 1000 tokens
  return { ...s, mint, vaultAta };
}

const meta = (pubkey: PublicKey, isWritable: boolean) => ({ pubkey, isSigner: false, isWritable });

const claim = (vault: PublicKey, c: Keypair, dest: PublicKey) =>
  program.methods.claim()
    .accountsPartial({ vault, claimant: c.publicKey, feePayer: me, destination: dest })
    .signers([c]).rpc();

function claimTokens(vault: PublicKey, c: Keypair, destWallet: PublicKey, mint: PublicKey, vaultAta: PublicKey, destTokenOverride?: PublicKey) {
  const destAta = destTokenOverride ?? getAssociatedTokenAddressSync(mint, destWallet, true);
  const b = program.methods.claim()
    .accountsPartial({ vault, claimant: c.publicKey, feePayer: me, destination: destWallet })
    .remainingAccounts([meta(vaultAta, true), meta(destAta, true), meta(TOKEN_PROGRAM_ID, false)])
    .signers([c]);
  return (destTokenOverride ? b : b.preInstructions([createAssociatedTokenAccountIdempotentInstruction(me, destAta, destWallet, mint)])).rpc();
}
const tokBal = async (ata: PublicKey) => Number((await getAccount(conn, ata)).amount);

describe("kinlock", () => {
  it("rejects bad shares, duplicate keys, and guardian == owner", async () => {
    const owner = Keypair.generate(); await fund(owner);
    const vault = pdaOf(owner.publicKey);
    const k1 = Keypair.generate().publicKey, k2 = Keypair.generate().publicKey;
    const init = (g: PublicKey | null, b: { claimKey: PublicKey; shareBps: number }[]) =>
      program.methods.initializeVault(new BN(10), new BN(1), g, new BN(0), null, b)
        .accountsPartial({ vault, owner: owner.publicKey, systemProgram: SystemProgram.programId }).signers([owner]).rpc();
    await fails(init(null, [{ claimKey: k1, shareBps: 5000 }, { claimKey: k2, shareBps: 4000 }]), "BadShares");
    await fails(init(null, [{ claimKey: k1, shareBps: 5000 }, { claimKey: k1, shareBps: 5000 }]), "DuplicateKey");
    await fails(init(owner.publicKey, [{ claimKey: k1, shareBps: 10000 }]), "BadGuardian");
  });

  it("blocks claims before the deadline", async () => {
    const { claimants, vault } = await setup({ interval: 30, grace: 30 });
    await fails(claim(vault, claimants[0], Keypair.generate().publicKey), "NotClaimable");
  });

  it("check-in resets the timer", async () => {
    const { owner, claimants, vault } = await setup({ interval: 3, grace: 1 });
    await waitChain(2);
    await program.methods.checkIn().accountsPartial({ vault, owner: owner.publicKey }).signers([owner]).rpc();
    await waitChain(2); // past the ORIGINAL deadline, not the new one
    await fails(claim(vault, claimants[0], Keypair.generate().publicKey), "NotClaimable");
  });

  it("splits SOL 70/30 exactly, blocks double claims and strangers, then locks the vault", async () => {
    const { owner, claimants, vault } = await setup({ shares: [7000, 3000] });
    await waitChain(6);
    const d1 = Keypair.generate().publicKey, d2 = Keypair.generate().publicKey;
    await fails(claim(vault, Keypair.generate(), d1), "NotBeneficiary");
    await claim(vault, claimants[0], d1);
    assert.equal(await conn.getBalance(d1), 0.7 * LAMPORTS_PER_SOL);
    await fails(claim(vault, claimants[0], d1), "AlreadyClaimed");
    await claim(vault, claimants[1], d2);
    assert.equal(await conn.getBalance(d2), 0.3 * LAMPORTS_PER_SOL);
    await fails(program.methods.checkIn().accountsPartial({ vault, owner: owner.publicKey }).signers([owner]).rpc(), "Locked");
    await fails(program.methods.ownerWithdraw(new BN(1)).accountsPartial({ vault, owner: owner.publicKey }).signers([owner]).rpc(), "Locked");
    await fails(program.methods.cancelVault().accountsPartial({ vault, owner: owner.publicKey }).signers([owner]).rpc(), "Locked");
  });

  it("rejects destination == vault", async () => {
    const { claimants, vault } = await setup();
    await waitChain(6);
    await fails(claim(vault, claimants[0], vault), "BadDestination");
  });

  it("guardian gate: too early, wrong signer, pending, then approved", async () => {
    const guardian = Keypair.generate(); await fund(guardian, 1);
    const { claimants, vault } = await setup({ guardian, gTimeout: 60, interval: 4 });
    const approve = (g: Keypair) => program.methods.guardianApprove().accountsPartial({ vault, guardian: g.publicKey }).signers([g]).rpc();
    await fails(approve(guardian), "TooEarly");
    await waitChain(6);
    const stranger = Keypair.generate(); await fund(stranger, 1);
    await fails(approve(stranger), "NotGuardian");
    const dest = Keypair.generate().publicKey;
    await fails(claim(vault, claimants[0], dest), "GuardianPending");
    await approve(guardian);
    await claim(vault, claimants[0], dest);
    assert.equal(await conn.getBalance(dest), LAMPORTS_PER_SOL);
  });

  it("guardian timeout lets beneficiaries claim without approval", async () => {
    const guardian = Keypair.generate();
    const { claimants, vault } = await setup({ guardian, gTimeout: 2 });
    await waitChain(7);
    const dest = Keypair.generate().publicKey;
    await claim(vault, claimants[0], dest);
    assert.equal(await conn.getBalance(dest), LAMPORTS_PER_SOL);
  });

  it("owner can withdraw within limits and cancel to recover everything", async () => {
    const { owner, vault } = await setup({ interval: 60 });
    const w = (n: number) => program.methods.ownerWithdraw(new BN(n)).accountsPartial({ vault, owner: owner.publicKey }).signers([owner]).rpc();
    await fails(w(2 * LAMPORTS_PER_SOL), "Insufficient");
    await w(0.5 * LAMPORTS_PER_SOL);
    const before = await conn.getBalance(owner.publicKey);
    await program.methods.cancelVault().accountsPartial({ vault, owner: owner.publicKey }).signers([owner]).rpc();
    assert.isNull(await conn.getAccountInfo(vault));
    assert.isAbove(await conn.getBalance(owner.publicKey), before + 0.49 * LAMPORTS_PER_SOL);
  });

  it("other people cannot check in or withdraw on someone else's vault", async () => {
    const { vault } = await setup({ interval: 60 });
    const thief = Keypair.generate(); await fund(thief, 1);
    await fails(program.methods.checkIn().accountsPartial({ vault, owner: thief.publicKey }).signers([thief]).rpc(), "Error");
    await fails(program.methods.ownerWithdraw(new BN(1)).accountsPartial({ vault, owner: thief.publicKey }).signers([thief]).rpc(), "Error");
    assert.isNotNull(await conn.getAccountInfo(vault));
  });

  // ---------- SPL token (USDC-style) ----------
  it("token: splits SOL and tokens 70/30 in the same claim", async () => {
    const { claimants, vault, mint, vaultAta } = await setupToken();
    await waitChain(6);
    const d1 = Keypair.generate().publicKey, d2 = Keypair.generate().publicKey;
    await claimTokens(vault, claimants[0], d1, mint, vaultAta);
    assert.equal(await conn.getBalance(d1), 0.7 * LAMPORTS_PER_SOL);
    assert.equal(await tokBal(getAssociatedTokenAddressSync(mint, d1, true)), 700_000_000);
    await claimTokens(vault, claimants[1], d2, mint, vaultAta);
    assert.equal(await tokBal(getAssociatedTokenAddressSync(mint, d2, true)), 300_000_000);
    assert.equal(await tokBal(vaultAta), 0);
  });

  it("token: claim fails without token accounts or with someone else's token account", async () => {
    const { claimants, vault, mint, vaultAta } = await setupToken([10000]);
    await waitChain(6);
    const dest = Keypair.generate().publicKey;
    await fails(claim(vault, claimants[0], dest), "TokenAccountsMissing");
    const stranger = Keypair.generate().publicKey;
    const strangerAta = getAssociatedTokenAddressSync(mint, stranger, true);
    await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(me, strangerAta, stranger, mint)));
    await fails(claimTokens(vault, claimants[0], dest, mint, vaultAta, strangerAta), "BadTokenAccount");
    assert.equal(await tokBal(vaultAta), 1_000_000_000); // nothing moved
  });

  it("token: owner can take tokens back before a claim, but not after", async () => {
    const { owner, claimants, vault, mint, vaultAta } = await setupToken([10000]);
    const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
    const withdraw = (n: number) =>
      program.methods.ownerWithdrawToken(new BN(n))
        .accountsPartial({ vault, owner: owner.publicKey, mint, vaultToken: vaultAta, ownerToken: ownerAta, tokenProgram: TOKEN_PROGRAM_ID })
        .preInstructions([createAssociatedTokenAccountIdempotentInstruction(me, ownerAta, owner.publicKey, mint)])
        .signers([owner]).rpc();
    await withdraw(400_000_000);
    assert.equal(await tokBal(ownerAta), 400_000_000);
    await waitChain(6);
    await claimTokens(vault, claimants[0], Keypair.generate().publicKey, mint, vaultAta);
    await fails(withdraw(1), "Locked");
  });
});
