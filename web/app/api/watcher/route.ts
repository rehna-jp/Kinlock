import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/server/db";
import { fetchVault, nowSec } from "@/lib/server/chain";
import { computeStatus } from "@/lib/shared";
import { clean, sendMail } from "@/lib/server/mail";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = Buffer.from(req.headers.get("authorization") ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const app = process.env.APP_URL!;
  const now = nowSec();
  const out = { checked: 0, ownerWarned: 0, guardianWarned: 0, beneficiariesNotified: 0, errors: [] as string[] };

  const { data: rows } = await db.from("vaults").select("*, beneficiaries(*)");
  for (const row of rows ?? []) {
    try {
      out.checked++;
      const v = await fetchVault(row.vault);
      if (!v) { await db.from("vaults").delete().eq("vault", row.vault); continue; } // cancelled on-chain
      if (now <= v.lastCheckIn + v.interval) continue; // owner is still checking in

      // Stage 1: owner (and guardian) warned once per check-in cycle
      if (Number(row.warned_for) !== v.lastCheckIn) {
        const owner = clean(row.owner_name);
        await sendMail(
          row.owner_email,
          "KinLock: you missed a check-in",
          `Hi ${owner},\n\nYour KinLock vault has missed its check-in. If you do nothing, your beneficiaries will be notified when the grace period ends.\n\nCheck in now: ${app}\n\nIf this was a mistake or you were away, checking in resets everything.`
        );
        out.ownerWarned++;
        if (row.guardian_email) {
          await sendMail(
            row.guardian_email,
            `KinLock: ${owner} missed a check-in`,
            `${owner} named you as guardian of their KinLock vault and has missed a check-in.\n\nTry to reach them first. Only if you believe they are unable to check in, approve release here:\n${app}/guardian/${row.vault}\n\nYou cannot move any funds; approval only lets their beneficiaries claim.`
          );
          out.guardianWarned++;
        }
        await db.from("vaults").update({ warned_for: v.lastCheckIn }).eq("vault", row.vault);
      }

      // Stage 2: beneficiaries notified once the vault is truly claimable
      if (computeStatus(v, now) === "claimable") {
        for (const b of row.beneficiaries ?? []) {
          const onChain = v.beneficiaries.find((x) => x.claimKey === b.claim_key);
          if (onChain?.claimed || Number(b.notified_for) === v.lastCheckIn) continue;
          const owner = clean(row.owner_name);
          await sendMail(
            b.email,
            `KinLock: ${owner} named you as a beneficiary`,
            `Hello ${clean(b.name)},\n\n${owner} set up an KinLock vault naming you as a beneficiary. They have not checked in for longer than their chosen limit, so your share is now available.\n\nClaim it here: ${app}/claim/${b.token}\n\nYou will need the passphrase ${owner} gave you separately. We never see it and cannot recover it.\n\nIf you were not expecting this message, ignore it.`
          );
          await db.from("beneficiaries").update({ notified_for: v.lastCheckIn }).eq("token", b.token);
          out.beneficiariesNotified++;
        }
      }
    } catch (e) {
      out.errors.push(`${row.vault}: ${(e as Error).message}`);
    }
  }
  return NextResponse.json(out);
}

export const POST = run;
export const GET = run;
