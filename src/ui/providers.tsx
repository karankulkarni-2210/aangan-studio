"use client";

import { ToastProvider } from "./components";
import { SessionProvider } from "./session";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ToastProvider>{children}</ToastProvider>
    </SessionProvider>
  );
}
