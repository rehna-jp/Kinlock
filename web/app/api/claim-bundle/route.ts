import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/server/db";
import { fetchVault, nowSec } from "@/lib/server/chain";
import { computeStatus } from "@/lib/shared";

export const dynamic = "force-dynamic";

// Returns the encrypted key bundle ONLY once the vault is claimable on-chain.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data: ben } = await db.from("beneficiaries").select("*, vaults(owner_name)").eq("token", token).maybeSingle();
  if (!ben) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const v = await fetchVault(ben.vault);
  if (!v) return NextResponse.json({ error: "This vault was cancelled by its owner." }, { status: 410 });

  const mine = v.beneficiaries.find((b) => b.claimKey === ben.claim_key);
  const status = mine?.claimed ? "claimed" : computeStatus(v, nowSec());
  return NextResponse.json({
    ownerName: ben.vaults?.owner_name ?? "the owner",
    name: ben.name,
    vault: ben.vault,
    claimKey: ben.claim_key,
    shareBps: ben.share_bps,
    status,
    mint: v.mint,
    blob: status === "claimable" ? ben.blob : null,
  });
}
