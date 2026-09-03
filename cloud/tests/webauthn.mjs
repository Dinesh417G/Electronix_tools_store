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
// A plain OPERATOR, from `npm run seed -- --demo-operators`. Step 8 is entirely
// about the role: everything above runs as an admin, which is the one role the
// old gate let through.
const OPERATOR_EMP_CODE = process.env.WEBAUTHN_OPERATOR_EMP_CODE ?? "E1042";
const OPERATOR_PIN = process.env.WEBAUTHN_OPERATOR_PIN ?? "3333";

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

    // Before anything is registered, which is the state every phone starts in
    // and the one the first user hit. Chrome answers `get()` with a
    // NotAllowedError that is indistinguishable from a cancelled prompt, so
    // what the screen says next is the entire remedy — and it used to name
    // "the admin console under Setup → Passkeys", a route that stopped
    // existing when operators got a page of their own. A message that sends
    // somebody to a screen they cannot reach is worse than no message: they
    // believe it and go looking.
    step("2b. the empty-device message names a route that exists");
    await clickText("Reader not working");
    await sleep(900);
    await clickText("Use fingerprint on this phone");
    await sleep(3500);
    const noneYet = await text();
    if (/No fingerprint on this phone yet/i.test(noneYet)) {
      ok("the screen explains there is nothing registered yet");
    } else {
      bad("no explanation on an unregistered device: " + trim(noneYet));
    }
    if (/Setup\s*→\s*Passkeys/i.test(noneYet)) {
      bad("it still sends the reader to Setup → Passkeys, which no longer exists");
    } else {
      ok("and does not name the section that was renamed away");
    }
    // An operator never sees Setup, so the only route that works for every
    // role is the gear and the admin entry behind it. Two weaker versions of
    // this assertion passed against the stale message before this one: /admin/
    // alone matched "the admin console", and the gear glyph alone matched the
    // floating settings button that is on this screen regardless. The pair in
    // sequence appears only inside the sentence being checked.
    if (/⚙\s*→\s*admin/.test(noneYet)) {
      ok("it names the gear → admin route a reader can follow");
    } else {
      bad("the message does not say how to get there: " + trim(noneYet));
    }
    if (/employee code and PIN/i.test(noneYet)) ok("and the PIN fallback below it");
    else bad("no mention of the PIN fallback");
    await goto(BASE);
    await sleep(500);

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
      const listed = /Fingerprint sign-in/.test(await text());
      await clickText("Fingerprint sign-in");
      await sleep(1500);
      return listed;
    };

    if (await openAdmin()) ok("signed in with employee code and PIN");
    else bad("admin console did not open");

    step("3. Setup → Fingerprint sign-in — the screen that had no way in until today");
    if (await openPasskeys()) ok("Setup lists a Fingerprint sign-in section");
    else bad("no Fingerprint sign-in section in Setup");
    const empty = await text();
    if (/No device is registered yet/i.test(empty)) ok("empty state renders before anything exists");
    else bad("unexpected first render: " + trim(empty));

    step("4. register — a real create() ceremony");
    if (!(await clickText("Use this device's fingerprint"))) {
      bad("no 'Use this device's fingerprint' button");
    }
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
      if (/No device is registered yet/i.test(after)) ok("the device is gone from the list");
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

    // Everything above signs in as an ADMIN, which is exactly why the gap it
    // covers survived: `register/options`, `register/verify`, `credentials` and
    // its DELETE all name OPERATOR explicitly, and the only screen that called
    // them lived inside a console `AdminLogin` refused to open for one. An
    // operator could sign in with a fingerprint and had no way to enrol one.
    //
    // `endpoint-callers.mjs` passes on that, and cannot not: it proves a route
    // has a caller somewhere in the file graph. It cannot see that the caller
    // sits behind a role gate the intended user fails. Reachable in the code,
    // unreachable in the product — which is why this step is a browser step and
    // not an assertion that an OPERATOR token gets a 200.
    step("8. an OPERATOR can reach it at all — the gap this run was written for");
    // Counted rather than assumed to be zero. Revoking in step 6 deleted our
    // row, not the credential on the device — a revoked passkey still lives on
    // the phone and the server simply refuses it, which is exactly what step 7
    // proves. So the authenticator still holds the admin's, and what this step
    // can claim is that the operator's registration added one more.
    const heldBefore = (await send("WebAuthn.getCredentials", { authenticatorId }))
      .credentials?.length ?? 0;
    await goto(BASE);
    if (/Sign out/.test(await text())) {
      await clickText("Sign out");
      await sleep(1500);
    }
    if (!(await clickSelector('button[aria-label="Settings"], button[title="Settings"]'))) {
      await clickText("⚙");
    }
    await sleep(800);
    await clickText("admin");
    await sleep(1200);
    await fill([
      ['input:not([type="password"])', OPERATOR_EMP_CODE],
      ['input[type="password"]', OPERATOR_PIN],
    ]);
    await clickText("Sign in");
    await sleep(2500);

    const operatorView = await text();
    if (/needs a storekeeper or administrator/i.test(operatorView)) {
      bad("the operator was refused at sign-in — the old gate is back");
    } else {
      ok("an OPERATOR is no longer refused at sign-in");
    }
    // Not /Fingerprint sign-in/: the sign-in *form* says those words too, in
    // the hint under the passkey button, so that pattern passes on the screen
    // that refused them. Caught by putting the old gate back — the step failed
    // six ways and these two still passed. Match the page's own subtitle and
    // its way out, neither of which the login form has.
    if (/Devices that can sign in as/i.test(operatorView) && /Sign out/.test(operatorView)) {
      ok("and lands on their own fingerprint page");
    } else {
      bad("no fingerprint page after an operator signed in: " + trim(operatorView));
    }
    // The console is catalog and policy and none of it is theirs; a tab that
    // answers 403 is worse than no tab.
    if (/Catalog|Ledger|Reports/.test(operatorView)) {
      bad("an OPERATOR was shown console tabs they cannot use");
    } else {
      ok("and no console tabs, which would all answer 403");
    }

    if (!(await clickText("Use this device's fingerprint"))) {
      bad("no register button on the operator's page");
    }
    await sleep(4000);
    const operatorRegistered = await text();
    if (/Registered\./i.test(operatorRegistered)) ok("an OPERATOR registered a fingerprint");
    else bad("the operator could not register: " + trim(operatorRegistered));

    const heldNow = (await send("WebAuthn.getCredentials", { authenticatorId }))
      .credentials?.length ?? 0;
    if (heldNow === heldBefore + 1) {
      ok(`the authenticator gained one credential (${heldBefore} → ${heldNow}) — create() really ran for an operator`);
    } else {
      bad(`the authenticator went ${heldBefore} → ${heldNow}, expected one more`);
    }

    // Revoking is the half that matters most to an operator: a lost phone is
    // their problem to report and, until this page existed, only SQL could fix
    // it. It also leaves the database as this test found it — every other test
    // here cleans up after itself, and a stray credential would show up on the
    // People list as "fingerprint on 1 device" forever.
    await clickText("Revoke");
    await sleep(600);
    if (!(await clickText("Yes, revoke it"))) bad("no confirmation after Revoke");
    await sleep(2000);
    if (/No device is registered yet/i.test(await text())) {
      ok("and can remove it again, which is what a lost phone needs");
    } else {
      bad("the operator could not revoke their own device");
    }
  } finally {
    await browser.close();
  }

  t.report();
}

await main();
