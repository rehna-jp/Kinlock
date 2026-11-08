import { PublicKey } from "@solana/web3.js";
import idl from "./idl.json";

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
// Circle devnet USDC. Override with NEXT_PUBLIC_TOKEN_MINT if you use another mint.
export const TOKEN_MINT = process.env.NEXT_PUBLIC_TOKEN_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const vaultPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), owner.toBytes()], PROGRAM_ID)[0];

export type VaultView = {
  owner: string;
  lastCheckIn: number;
  interval: number;
  grace: number;
  guardian: string | null;
  guardianTimeout: number;
  guardianApproved: boolean;
  locked: boolean;
  mint: string | null;
  beneficiaries: { claimKey: string; shareBps: number; claimed: boolean }[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseVaultRaw(a: any): VaultView {
  if (!a || a.lastCheckIn === undefined) throw new Error("Unexpected vault layout. Keys: " + Object.keys(a ?? {}).join(","));
  return {
    owner: a.owner.toBase58(),
    lastCheckIn: a.lastCheckIn.toNumber(),
    interval: a.interval.toNumber(),
    grace: a.grace.toNumber(),
    guardian: a.guardian ? a.guardian.toBase58() : null,
    guardianTimeout: a.guardianTimeout.toNumber(),
    guardianApproved: a.guardianApproved,
    locked: a.locked,
    mint: a.mint ? a.mint.toBase58() : null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beneficiaries: a.beneficiaries.slice(0, a.count).map((b: any) => ({
      claimKey: b.claimKey.toBase58(),
      shareBps: b.shareBps,
      claimed: b.claimed,
    })),
  };
}

export type Status = "active" | "grace" | "awaiting_guardian" | "claimable" | "claimed";

// Mirrors the on-chain rules in `claim`. The program is the real authority.
export function computeStatus(v: VaultView, now: number): Status {
  if (v.locked && v.beneficiaries.every((b) => b.claimed)) return "claimed";
  const due = v.lastCheckIn + v.interval;
  if (now <= due) return "active";
  const open = due + v.grace;
  if (now <= open) return "grace";
  if (v.guardian && !v.guardianApproved && !(v.guardianTimeout > 0 && now > open + v.guardianTimeout))
    return "awaiting_guardian";
  return "claimable";
}

const camel = (k: string) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function norm(x: any): any {
  if (Array.isArray(x)) return x.map(norm);
  if (x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype)
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [camel(k), norm(v)]));
  return x;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseVault(a: any): VaultView {
  return parseVaultRaw(norm(a));
}
