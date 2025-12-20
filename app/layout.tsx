import AuthGate from "./_providers/AuthGate";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VetVoice",
  description: "VetVoice – dokumentacja badań weterynaryjnych",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pl" suppressHydrationWarning>
      <body
        className={[
          geistSans.variable,
          geistMono.variable,
          "antialiased",
          // 👇 GLOBALNY APP SHELL
          "min-h-screen",
          "bg-slate-50",
          "text-slate-900",
        ].join(" ")}
      >
        <AuthGate>
          {/* APP CONTAINER */}
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {/* opcjonalny górny odstęp */}
            <div className="py-6">{children}</div>
          </div>
        </AuthGate>
      </body>
    </html>
  );
}
