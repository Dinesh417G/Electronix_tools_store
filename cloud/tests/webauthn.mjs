// Drive the whole passkey ceremony against a real Chrome, with no hardware.
//
// CLAUDE.md §8 makes passkeys the fourth identity source and §13 left the
// ceremony untested — "needs a real device on HTTPS". A CDP virtual
// authenticator is that device: Chrome implements it inside the same WebAuthn
// stack a real security key drives, so `navigator.credentials.create()` and
// `.get()` run for real — challenge, attestation, signature, sign counter.
// What it does not prove is a particular phone's secure enclave or the
// platform's own prompt. localhost is a secure origin, so no HTTPS is needed.
//
// What it checks, in order: the screen renders, registration creates a real
// credential, that credential signs the operator in on the terminal, revoking
// it removes it, and a revoked credential can no longer open a session — which
// is the whole reason the revoke button had to exist.
//
//   STORE_BASE=… STORE_ENROLMENT_SECRET=… DATABASE_URL=… node tests/webauthn.mjs
//
// Chrome is found from CHROME_PATH, or from the usual install locations. There
// is no graceful skip: a gate that quietly does nothing is how §13 ended up
// with five routes nobody had ever run.

import { launchChrome, sleep, tally, trim } from "./cdp.mjs";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SECRET = process.env.STORE_ENROLMENT_SECRET;
const EMP_CODE = process.env.WEBAUTHN_EMP_CODE ?? "E1001";
const PIN = process.env.WEBAUTHN_PIN ?? "1111";

if (!SECRET) {
  console.error("STORE_ENROLMENT_SECRET is required — the browser has to enrol as a terminal first");
  process.exit(1);
}


const t = tally();
const { ok, bad, step } = t;

async function main() {
  // Everything below used to be a second copy of tests/cdp.mjs, launcher and
  // all — which is how one bug lived in two files and got fixed in neither.
  const browser = await launchChrome();
  const { send, evaluate, goto, text, clickText, clickSelector, fill } = browser;

  try {
    step("1. a virtual authenticator, standing in for the operator's phone");
    await send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",   // a platform authenticator, as a phone is
        hasResidentKey: true,    // discoverable: sign-in needs no username
        hasUserVerification: true,
        isUserVerified: true,    // the fingerprint "succeeds"
        automaticPresenceSimulation: true,
      },
    });
    ok(`virtual platform authenticator attached (${authenticatorId.slice(0, 8)}…)`);

    step("2. enrol this browser as a terminal, then sign in as the admin");
    await goto(BASE);

    const env = await evaluate(`({
      hasPKC: typeof window.PublicKeyCredential !== "undefined",
      secure: window.isSecureContext,
    })`);
    if (env.hasPKC && env.secure) ok("secure context, WebAuthn available");
    else bad(`WebAuthn unavailable: ${JSON.stringify(env)}`);

    if ((await evaluate('document.querySelectorAll("input").length')) >= 2) {
      await fill([['input[type="password"]', SECRET]]);
      if (await clickText("Enrol this device")) ok("device enrolled");
      else bad("no 'Enrol this device' button");
      await sleep(2000);
    } else {
      ok("device already enrolled");
    }

    // The settings entry is an icon button: the text is a gear glyph and the
    // name lives in aria-label, so matching on text does not find it.
    const openAdmin = async () => {
      await goto(BASE);
      if (!(await clickSelector('button[aria-label="Settings"], button[title="Settings"]'))) {
        await clickText("\u2699");
      }
      await sleep(800);
      await clickText("admin");
      await sleep(1200);
      await fill([
        ['input:not([type="password"])', EMP_CODE],
        ['input[type="password"]', PIN],
      ]);
      await clickText("Sign in");
      await sleep(2000);
      return /Catalog/i.test(await text());
    };

    const openPasskeys = async () => {
      await clickText("Setup");
      await sleep(900);
      const listed = /Passkeys/.test(await text());
      await clickText("Passkeys");
      await sleep(1500);
      return listed;
    };

    if (await openAdmin()) ok("signed in with employee code and PIN");
    else bad("admin console did not open");

    step("3. Setup → Passkeys — the screen that had no way in until today");
    if (await openPasskeys()) ok("Setup lists a Passkeys section");
    else bad("no Passkeys section in Setup");
    const empty = await text();
    if (/No passkey is registered/i.test(empty)) ok("empty state renders before anything exists");
    else bad("unexpected first render: " + trim(empty));

    step("4. register — a real create() ceremony");
    if (!(await clickText("Register this device"))) bad("no 'Register this device' button");
    await sleep(4000);
    const registered = await text();
    if (/Registered\./i.test(registered)) ok("the screen reports it registered");
    else bad("no success notice: " + trim(registered));

    const held = await send("WebAuthn.getCredentials", { authenticatorId });
    if (held.credentials?.length === 1) ok("the authenticator holds one credential — create() really ran");
    else bad(`the authenticator holds ${held.credentials?.length ?? 0} credentials`);

    step("5. sign in with it on the terminal — a real get() ceremony");
    const passkeySignIn = async () => {
      await goto(BASE);
      // The console survives a reload, so getting back to the terminal means
      // signing out of it. Without this the check reads the admin screen and
      // reports "no session opened" for the wrong reason — and step 7 would
      // pass vacuously, which is worse.
      if (/Sign out/.test(await text())) {
        await clickText("Sign out");
        await sleep(1500);
      }
      const onTerminal = /Reader not working|finger on the door reader/i.test(await text());
      if (!onTerminal) bad("could not get back to the terminal: " + trim(await text()));
      await clickText("Reader not working");
      await sleep(900);
      const offered = await clickText("Use fingerprint on this phone");
      await sleep(3500);
      return { offered, body: await text() };
    };

    const signIn = await passkeySignIn();
    if (signIn.offered) ok("the terminal offers the passkey button");
    else bad("no 'Use fingerprint on this phone' button on the manual screen");
    if (/TAKE OUT|PUT IN/i.test(signIn.body)) ok("signed in — the terminal advanced to TAKE OUT / PUT IN");
    else bad("passkey sign-in opened no session: " + trim(signIn.body));

    step("6. revoke it");
    if (await openAdmin()) {
      await openPasskeys();
      await clickText("Revoke");
      await sleep(600);
      if (!(await clickText("Yes, revoke it"))) bad("no confirmation after Revoke");
      await sleep(2000);
      const after = await text();
      if (/No passkey is registered/i.test(after)) ok("the device is gone from the list");
      else bad("still listed after revoke: " + trim(after));
    } else {
      bad("could not get back into the console to revoke");
    }

    step("7. and now it cannot sign in — which is the point of the button");
    const afterRevoke = await passkeySignIn();
    if (/TAKE OUT|PUT IN/i.test(afterRevoke.body)) {
      bad("a REVOKED passkey still opened a session");
    } else {
      ok("the revoked passkey no longer opens a session");
    }
  } finally {
    await browser.close();
  }

  t.report();
}

await main();
