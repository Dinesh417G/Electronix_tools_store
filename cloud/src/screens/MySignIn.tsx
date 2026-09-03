// An operator's own sign-in page.
//
// The gap this closes: every WebAuthn route already allows an `OPERATOR` —
// `register/options`, `register/verify`, `credentials` and its DELETE all name
// the role explicitly — but the only screen that called them lived inside the
// admin console, and `AdminLogin` refused anybody who was not ADMIN or
// STOREKEEPER. So §8's passkey path was permitted by the API and unreachable by
// the people it was written for. An operator could sign in with a fingerprint
// and could never register one.
//
// `endpoint-callers.mjs` passes on this, and that is worth stating: it proves a
// route has a caller somewhere in the file graph. It cannot see that the caller
// sits behind a role gate the intended user fails. Same failure mode as dead
// wiring, one level up — reachable in the code, unreachable in the product.
//
// Why a separate screen rather than opening the console to operators: nothing
// else in there is theirs. The console is catalog and policy, and a screen full
// of tabs that answer 403 is worse than no screen. This is the one thing an
// operator owns — which of their devices may act as them — plus the way out.

import { useMemo, useState } from "react";
import { adminApi } from "../lib/admin";
import { Banner, Screen } from "../components/ui";
import { Passkeys } from "./Passkeys";

export function MySignIn({
  token,
  operatorName,
  onSignOut,
}: {
  token: string;
  operatorName: string;
  onSignOut: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const client = useMemo(() => adminApi(token), [token]);

  return (
    <Screen>
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-24">
        <div className="space-y-3">
          {error && (
            <Banner tone="error" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          )}
          {notice && (
            <Banner tone="success" onDismiss={() => setNotice(null)}>
              {notice}
            </Banner>
          )}

          {/* No `onBack`: there is no console behind this one. Signing out is
              the only way off it, and it belongs in the header rather than at
              the bottom of a list that scrolls. */}
          <Passkeys
            client={client}
            token={token}
            operatorName={operatorName}
            onError={setError}
            onNotice={setNotice}
            right={
              <button
                type="button"
                onClick={onSignOut}
                className="tap rounded-xl px-3 py-2 text-sm text-slate-400 active:bg-slate-800"
              >
                Sign out
              </button>
            }
          />

          <p className="pt-2 text-sm text-slate-500">
            Registering here means you can open a session at the terminal with
            this phone&apos;s fingerprint instead of typing your PIN. It is not
            the door reader: the reader matches your finger against what is
            enrolled on the terminal itself, and a storekeeper sets that up at
            the door.
          </p>
        </div>
      </div>
    </Screen>
  );
}
