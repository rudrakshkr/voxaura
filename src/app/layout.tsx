import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voxaura — Voice Salary Negotiation Simulator",
  description:
    "Practice salary negotiation against a realistic AI recruiter over live voice, then get scored on your performance.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
      </body>
    </html>
  );
}
