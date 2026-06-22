import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";

export const metadata: Metadata = {
  title: "CourtThread",
  description: "Message thread viewer for court evidence",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-[100dvh]">
        <Sidebar />
        <main className="flex-1 ml-64 p-6 min-w-0">{children}</main>
      </body>
    </html>
  );
}
