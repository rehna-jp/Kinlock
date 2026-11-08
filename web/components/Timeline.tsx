import { Status } from "@/lib/shared";

const ORDER: Status[] = ["active", "grace", "awaiting_guardian", "claimable", "claimed"];
const NAMES: Record<Status, string> = { active: "Active", grace: "Grace", awaiting_guardian: "Guardian", claimable: "Claimable", claimed: "Claimed" };

export default function Timeline({ status, guardian }: { status: Status; guardian: boolean }) {
  const steps = ORDER.filter((s) => guardian || s !== "awaiting_guardian");
  const cur = steps.indexOf(status);
  return (
    <ol className="timeline" aria-label="Vault stages">
      {steps.map((s, i) => (
        <li key={s} className={i < cur ? "done" : i === cur ? "now" : ""} aria-current={i === cur ? "step" : undefined}>
          <span className="dot" />
          {NAMES[s]}
        </li>
      ))}
    </ol>
  );
}
