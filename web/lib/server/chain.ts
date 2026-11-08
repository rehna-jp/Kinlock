import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import idl from "../idl.json";
import { PROGRAM_ID, parseVault, VaultView } from "../shared";

export const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
export const relayer = () => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.RELAYER_SECRET_KEY!)));
export const nowSec = () => Math.floor(Date.now() / 1000);

const coder = new BorshAccountsCoder(idl as Idl);

export async function fetchVault(addr: string): Promise<VaultView | null> {
  const info = await connection.getAccountInfo(new PublicKey(addr));
  if (!info) return null;
  if (!info.owner.equals(PROGRAM_ID)) throw new Error("Account is not owned by the KinLock program");
  return parseVault(coder.decode("Vault", info.data));
}
