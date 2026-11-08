"use client";
import { useMemo } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program, Idl } from "@coral-xyz/anchor";
import idl from "./idl.json";

export function useProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const program = useMemo(
    () => (wallet ? new Program(idl as Idl, new AnchorProvider(connection, wallet, { commitment: "confirmed" })) : null),
    [connection, wallet]
  );
  return { program, wallet, connection };
}
