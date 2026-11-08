import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const base = process.argv[2] ?? "http://localhost:3000";
const every = Number(process.argv[3] ?? 20) * 1000;

async function tick() {
  const t = new Date().toLocaleTimeString();
  try {
    const r = await fetch(base + "/api/watcher", { method: "POST", headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
    const j = await r.json();
    const sent = j.ownerWarned || j.guardianWarned || j.beneficiariesNotified || j.errors?.length;
    console.log(t, sent ? JSON.stringify(j) : `checked ${j.checked ?? "?"} vault(s), nothing to send (${r.status})`);
  } catch (e) { console.log(t, "watcher error:", e.message); }
}
tick();
setInterval(tick, every);
