import type { Metadata } from "next";
import "./globals.css";
import FirebaseProvider from "@/components/firebase-provider";

export const metadata: Metadata = {
  title: "Financials",
  description: "A private home for your spending data.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <FirebaseProvider>{children}</FirebaseProvider>
      </body>
    </html>
  );
}
