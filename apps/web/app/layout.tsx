// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "ccgrapher",
  description: "Lint an agent workflow for wasted sequencing, and see the graph go wide.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
