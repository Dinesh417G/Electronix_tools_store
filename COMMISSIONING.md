# Commissioning the tool store

For the person standing at the server PC on day one, with a door terminal in a
box and nothing installed. Work top to bottom. Every step says what you should
see; if you see something else, stop there rather than carrying on — a store
commissioned on a wrong assumption is harder to unpick than one that stalled.

Budget about two hours, plus however long the electrician takes with the door.

You need:

- the server PC, on the plant LAN, with a **static IP** — write it down now, you
  will type it into the door terminal and into every phone
- the `store-server` and `store-cli` binaries (a release tarball, or
  `cargo build --release`)
- the ZKTeco/eSSL terminal, powered and on the same LAN
- one Android phone to prove the loop before any tablet is mounted
- your item list — codes, descriptions, bin locations, reorder levels

> **A note on order.** Step 4 must come before step 5: the server creates the
> database schema when it first boots, and `store-cli` cannot do anything
> useful until it has.

---

## 1. Postgres

Neither installer touches PostgreSQL, deliberately — a tool crib's database
should be set up by somebody who chose the password and knows where the backups
go, not by a script guessing.

Install PostgreSQL 16, then:

```sql
CREATE ROLE electronix LOGIN PASSWORD 'pick-a-real-one';
CREATE DATABASE electronix_store OWNER electronix;
```

Check it answers:

```sh
psql "postgres://electronix:pick-a-real-one@localhost/electronix_store" -c 'select 1'
```

> **Expected:** one row, `1`. A failure here is a Postgres problem — `pg_hba.conf`
> or the listen address — and nothing further will work until it is fixed.

## 2. Install the server

**Linux**

```sh
sudo deploy/linux/install.sh
```

**Windows** (elevated PowerShell, with `WinSW-x64.exe` beside the script)

```powershell
.\deploy\windows\Install-StoreServer.ps1 -WinSwPath .\WinSW-x64.exe
```

Both create a service, generate an enrolment secret, and schedule the nightly
backup for 02:15. Neither starts the server yet — it has no database URL.

> **Expected:** a message pointing at the config file it just wrote:
> `/etc/electronix-store/server.env`, or `C:\ElectronIx\ToolStore\config\server.env`.

## 3. Point it at the database

Edit that config file and set `DATABASE_URL` to the connection string from
step 1.

While you are in there, find `STORE_ENROLMENT_SECRET`. The installer generated
one. **Copy it somewhere you can read it from a phone** — you will type it once
per device in step 8. Treat it like a password: anyone with it can turn a phone
into a terminal.

Leave `STORE_LISTEN=0.0.0.0:8080` alone unless something else on the PC wants
8080. If you change it, the door terminal and every phone need the new port too.

## 4. Start it

```sh
sudo systemctl start store-server     # Linux
Start-Service ElectronIxToolStore     # Windows
```

The server runs its migrations on boot, so there is no separate schema step.

```sh
curl localhost:8080/api/v1/version
```

> **Expected:** JSON with a version, a git sha and a build time.
> **If it fails:** `journalctl -u store-server -n 50`, or the WinSW log in the
> install directory. A bad `DATABASE_URL` is the usual answer.

## 5. Create the first admin

Nobody can sign in yet. The admin console needs an `ADMIN` operator, and
creating operators needs an admin — so the first one is made here, on the
machine, by somebody who already has the database password.

```sh
store-cli operator add --emp-code E9001 --name "S. Rao" --role ADMIN --zk-user-id 9001
```

It asks for a PIN. To keep it out of your shell history, pipe it instead:

```sh
echo 8341 | store-cli operator add --emp-code E9001 --name "S. Rao" --role ADMIN --zk-user-id 9001
```

> **Expected:** `created E9001 (ADMIN)  id …` and the sign-in address.

Then check it:

```sh
store-cli operator list
```

`--zk-user-id` is the user id programmed into the **door terminal**, not the
employee code. They can be the same number; they usually are not. Anyone
without one can still work, but their punch will never be matched to them and
they will have to use *Enter manually* every time — so `operator list` flags
them.

Add the storekeeper the same way (`--role STOREKEEPER`, with a PIN). Everyone
else can be added from the console in step 9, or here — whichever is faster
with the list you have.

## 6. Sign in

Open `http://<server-ip>:8080` on the server PC, then **⚙ → Admin**, and sign
in with the employee code and PIN from step 5.

> **Expected:** the admin console — catalog, stock, alerts, ledger.
> **If the PIN is refused:** `store-cli operator set-pin --emp-code E9001` and
> try again. It rewrites the hash, so a forgotten PIN is never a lockout.

## 7. Load the catalog

In the console: **Catalog → New item**. For each item you need at least an item
code, a description, a UoM and a bin location. `reorder_level` is what makes
alerts work — an item left at 0 will never warn you.

Then book what is physically in the bins. Do this as an `OPENING` movement, not
by editing a number: there is no number to edit. Stock is the sum of the ledger
(§7), and opening balances are part of that history.

> **Expected:** **Stock** shows each item with the on-hand you counted.
> Then, from the server PC:
>
> ```sh
> store-cli reconcile
> ```
>
> **Expected:** no drift. If it reports any, stop and raise it — drift is a bug
> in the software, not a data-entry mistake to be corrected by hand.

## 8. Turn a phone into a terminal

On an Android phone on the plant LAN, open `http://<server-ip>:8080`.

It asks for a terminal id, a name and the enrolment secret from step 3. Give it
something you will recognise in the ledger later — `TAB-STORE-1`, not `phone`.

> **Expected:** the idle screen, with the store name and a clock.

Add it to the home screen and it launches like an app. Use Chrome: barcode
scanning uses the browser's `BarcodeDetector`, which Android Chrome has and iOS
Safari does not. On a browser without it the terminal opens on search instead of
on a camera that cannot work — usable, just slower.

## 9. Print and scan a label

**Catalog → select items → Print labels** produces a PDF; print it on the label
stock you will actually use, at 100% scale with no "fit to page".

Then scan one from the phone.

> **Expected:** the correct item card, with its bin location and on-hand.
> **If it will not read:** print again at a higher density before changing
> anything in software. Toner spread at small module widths is the usual cause.

This step is the last unproven link in the chain. The software half is checked
in CI — the label PDF is rastered and decoded back through the lookup endpoint
at four print resolutions — but ink, paper and a real camera are not something
a test can stand in for.

## 10. The door

Have the terminal wired so it drives the lock **itself**: relay to the EM lock,
exit button, door sensor. This software never opens the door and cannot; the
store must keep working when the server PC is off.

Before trusting the integration, capture what the terminal actually sends. Stop
the server first — the probe wants the same port:

```sh
sudo systemctl stop store-server
store-cli device-probe --listen 8080 --out-dir adms-capture
```

In the terminal's menu, set the ADMS/cloud server address to the server PC's IP
and port 8080, then punch a few times with different fingers and cards.

> **Expected:** files appearing in `adms-capture` — a handshake on
> `/iclock/cdata`, then one `ATTLOG` post per punch.

**Now read them.** Firmware families differ in casing, parameter names and
stamp semantics, and `CLAUDE.md` §9 is written from documentation rather than
from your device. Compare the capture against §9. If they disagree, the capture
is right — update §9 and the parser, and keep the capture as a CI fixture so
the next firmware change is caught rather than discovered.

Then restart the server and punch once more:

```sh
sudo systemctl start store-server
```

> **Expected:** within a second or two, the phone shows a name card with the
> right person on it.
>
> **A card with no name** means the punch arrived but its user id matches no
> operator — fix that person's `--zk-user-id`. The punch is still recorded;
> nothing is lost.
>
> **No card at all** means the terminal is not reaching the server. Check its
> server address and port, and the PC's firewall on 8080.

## 11. Prove the loop

With the door terminal live, do one real transaction, watched:

1. Punch at the door.
2. Tap your name on the phone.
3. **TAKE OUT**, scan an item, quantity 2, **SKIP** the machine and reason.
4. Confirm.

> **Expected:** a success screen showing the new on-hand, two lower than before.
> In the console, **Ledger** shows one `ISSUE` row with your name, the item, the
> quantity and the time.

Then issue past an item's reorder level on purpose.

> **Expected:** the confirmation says the item is now LOW, an alert appears in
> the console, and the terminal's idle screen carries a banner.

Finally:

```sh
store-cli reconcile
```

> **Expected:** no drift. This is the check that says the ledger and the
> displayed stock agree. Run it whenever anything looks wrong.

## 12. Backups

Both installers schedule a nightly dump at 02:15. Do not wait for it — run one
now, while somebody who understands it is standing there:

```sh
store-cli backup --out-dir /var/backups/electronix-store --keep 14
```

> **Expected:** three lines — the ledger reconciled, the dump written with a
> size, and `verify: restored and matched the original`.

That last line is the one that matters. It restored the dump into a scratch
database and compared the ledger against the original. A backup nobody has ever
restored is a hope, not a backup.

Then copy a dump off the machine and make sure that keeps happening. A backup
on the same disk as the database protects against exactly one failure, and not
the common one.

---

## Handover

Leave these with the storekeeper, written down:

| | |
|---|---|
| Server address | `http://<server-ip>:8080` |
| Their sign-in | employee code + PIN |
| Enrolment secret | for adding a device — kept, not shared |
| Database password | somewhere that is not the server PC |

And three things worth saying out loud:

- **The door works without any of this.** The terminal owns the lock. If the
  server PC is off, people still get in; the movements simply are not logged.
- **A phone with no signal still works.** Transactions queue on the device,
  marked pending, and flush when the network returns. Nothing is lost and
  nothing is double-counted.
- **Stock is never edited.** A mistake is corrected by reversing it — the
  console does this in one tap, from the ledger. The original row stays, which
  is the whole point: in six months, "what happened" and "what we have" are the
  same record rather than two that quietly disagree.

## When something is wrong

| Symptom | First thing to check |
|---|---|
| No name card after a punch | Terminal's server address; firewall on 8080; `--zk-user-id` matches |
| Card appears with no name | That person has no `zk_user_id` — `store-cli operator list` |
| Scan does nothing | Not Chrome, or camera permission denied. *Search instead* still works |
| "Only N left in system" | Real: the bin disagrees with the ledger. Count it and book an adjustment |
| Transaction refused, session closed | The session timed out (180 s idle). Punch again; the typing is kept |
| Stock looks wrong | `store-cli reconcile`. Drift is a bug — report it, do not patch it by hand |
| Server will not start | `journalctl -u store-server -n 50`; usually `DATABASE_URL` |
