// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import "./globals.css";
import { BOOT_SCRIPT } from "../lib/preferences";

export const metadata = {
  title: "ccgrapher",
  description: "Lint an agent workflow for wasted sequencing, and see the graph go wide.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
