"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./WalletButton";

export default function Header() {
  const path = usePathname() ?? "/";
  return (
    <header className="top">
      <Link href="/" className="brand">
        <svg width="30" height="30" viewBox="0 0 28 28" aria-hidden="true">
          <rect width="28" height="28" rx="8" fill="#c8ff3e" />
          <circle cx="14" cy="12" r="4" fill="#0b1300" />
          <path d="M12 15.5h4l1.5 7h-7z" fill="#0b1300" />
        </svg>
        <span>KinLock</span>
      </Link>
      <span className="pill">Devnet</span>
      <span className="grow" />
      {!path.startsWith("/claim") && <WalletButton />}
    </header>
  );
}
