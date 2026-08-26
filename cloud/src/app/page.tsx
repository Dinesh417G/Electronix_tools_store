// The whole terminal is one client-side flow: the operator moves between
// screens faster than a round trip, and §12 budgets eight seconds for
// scan → qty → confirm. Server components would put a network hop between
// every tap.

import { AppShell } from "./app-shell";

export default function Page() {
  return <AppShell />;
}
