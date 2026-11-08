import "./globals.css";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import Providers from "./providers";
import Header from "@/components/Header";

const sans = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata = { title: "KinLock", description: "Crypto inheritance on Solana (devnet demo)" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable}`}>
        <Providers>
          <Header />
          {children}
        </Providers>
        <div className="footer">Devnet demo. Unaudited. Never use real funds.</div>
      </body>
    </html>
  );
}
