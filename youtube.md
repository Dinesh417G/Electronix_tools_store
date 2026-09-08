# ElectronIx Tool Store — YouTube Voiceover Script

A page-by-page narration script. Each heading is one screen. Under each:
**Show** (what to have on camera), **Say** (read this aloud), and a rough
duration. Total runtime as written: about 12–14 minutes. Cut any section
marked *optional* for a 6-minute version.

Recording notes:
- Record the terminal on a phone-shaped window (412 × 915) — that is the shape
  it was designed and tested at. The console records better at desktop width.
- Do a dry run of the issue flow first. The target is scan → quantity → confirm
  in under eight seconds, and the video should show it at that speed, not at
  narration speed.
- Say numbers out loud as the screen shows them. "On hand falls from 40 to 38"
  is the whole product in one sentence.

---

## 0. Cold open — the problem

**Show:** A real tool crib if you have one; otherwise the idle screen with the
TODAY strip populated.

**Say:**
> Every machine shop has a room like this. Carbide inserts, end mills, drills,
> taps, holders. Thousands of pounds of tooling on shelves, and a notebook by
> the door that nobody fills in after the second week.
>
> So nobody can answer the only question that matters: where did forty inserts
> go, who took them, and onto which machine?
>
> This is ElectronIx Tool Store. It digitises exactly one loop — a person walks
> in, takes something, and the system knows. Everything else you are about to
> see is a read of that one record.

*(~25 s)*

---

## 1. The loop, in one picture

**Show:** A simple diagram, or talk over shots of the door and the tablet.

**Say:**
> Here is the whole flow. An operator puts a finger on the door terminal. The
> terminal verifies them and unlocks the door itself — our software is never in
> that loop, so the door still works when we are down. It then pushes us a
> record: user 1042 verified at 14:32.
>
> The tablet inside the store wakes up with that person's name. They pick a
> direction, scan a bin, type a quantity, confirm. One row is written. Stock is
> recalculated. If it crossed the reorder level, an alert is raised.
>
> That is the product. Now let us walk through every screen.

*(~30 s)*

---

## 2. Enrolling a device

**Show:** The Enrol screen — terminal id, name, shared secret.

**Say:**
> First, once per device. A phone or a wall tablet has to be enrolled before it
> can act as a terminal. You give it an id, a name so it is recognisable in the
> device list later, and a shared secret that is typed here rather than baked
> into the app.
>
> That last part is deliberate. If the secret lived in the build, a bookmarked
> URL would be a working terminal. This way it is not.
>
> Enrol once, and the device holds a long-lived token. You never see this screen
> again.

*(~30 s)*

---

## 3. The idle screen

**Show:** The terminal at rest. Point at each block as you name it.

**Say:**
> This is what the tablet shows when nobody is standing at it, and the order of
> things on it is the design.
>
> Top: the store name and a one-line clock. It is a line, not a headline — the
> phone already has a clock six pixels above it.
>
> Then the way in. The sign-in button is the biggest thing on the screen, and
> the sentence under it changes depending on what this crib actually has. If a
> door reader has ever checked in, it tells you to use it. If none ever has, it
> does not mention a reader at all — because a crib that never bought one should
> never be told to go and touch it.
>
> Then what is short. These chips are counts of low and empty items, and they
> are tappable. "Two items are empty" is a dead end; tapping it and getting the
> two bins is not.
>
> And then TODAY: how many movements the crib has seen since local midnight, how
> many out, how many in, and the last twenty rows as a table. Direction lives in
> the sign of the quantity — minus two in red, plus two in green — so your eye
> reads a column of numbers, not a column of arrows.
>
> One detail worth calling out: the counts and the rows are scoped to the same
> window. An earlier version counted seven movements above a list of eight, and
> a panel that disagrees with itself teaches you to distrust every number on the
> screen — including the stock figures, which are the product.

*(~60 s)*

---

## 4. Shortages

**Show:** Tap the LOW or EMPTY chip.

**Say:**
> Tapping a chip opens the shortage list, filtered to that level. Item code,
> what it is, the bin, and how much is left. This is the storekeeper's morning
> screen: what do I need to order, and which shelf is empty right now.

*(~15 s)*

---

## 5. The claim screen — two people, one punch

**Show:** Two unclaimed name cards.

**Say:**
> Here is the problem this screen exists for. Two people walk in on one punch.
> Somebody holds the door. So a punch does not become a session — it *offers*
> one.
>
> Every unclaimed punch from the last ninety seconds shows up as a name card,
> and each person taps their own. Tailgating is solved socially, by the people
> standing there, which is the only place it can be solved.
>
> A claimed session is bound to that one tablet. If a second tablet tries to
> claim the same card, it is refused and told which tablet holds it. If nobody
> claims within ninety seconds, the offer expires.
>
> And if there is only one card, it advances on its own. Nobody should have to
> tap their own name when they are the only person in the room.

*(~40 s)*

---

## 6. Signing in without the door

**Show:** The manual sign-in screen — employee code and PIN — then the
fingerprint button.

**Say:**
> The door is optional, and it can also be down. So there are three ways in, and
> the system records which one you used, because they are not equal evidence.
>
> A door punch means a terminal matched a fingerprint against enrolled templates
> and decided whose it was. Fingerprint sign-in on a phone means a device that
> person registered was unlocked by someone that device trusts. A typed PIN
> means somebody typed an employee code and four digits.
>
> All three open a session. All three write stock. But the reports can tell them
> apart, and a session that did not come from the door is flagged — because
> pretending they are the same is what makes an audit trail undefensible.
>
> The PIN path has a brake on it: ten wrong attempts against one employee code,
> or twenty from one address, and it stops answering for fifteen minutes —
> including for the correct PIN, because a throttle that still checks the PIN
> has slowed nothing down.

*(~45 s)*

---

## 7. Direction — take out or put in

**Show:** The two big buttons.

**Say:**
> Two buttons, and nothing else on the screen. Red: take out. Green: put in.
>
> This is a shop-floor operator with oily gloves standing next to a running
> machine. Every screen in this flow is designed against one number — scan to
> confirm in under eight seconds. If a screen does not serve that, it is cut.

*(~20 s)*

---

## 8. Finding the item

**Show:** The camera opening, a scan resolving; then tap "Search instead" and
type.

**Say:**
> The camera opens immediately. Point it at the bin label — that is a Code 128
> barcode of our own item code — and the item card appears: description, bin
> location, and what the system thinks is on hand right now.
>
> A vendor's own printed barcode works too. We keep a table of alternate codes,
> so a manufacturer's EAN resolves to our item.
>
> "Search instead" is permanently on screen, never buried. It searches item
> code, description, ISO code and grade — so CNMG120408 finds the insert, and so
> does "12 mm four flute".
>
> Both paths land on the same card. That matters more than it sounds: on a
> browser with no barcode support, this screen simply opens on search rather
> than on a camera that will never work. The flow is unchanged, not crippled.

*(~40 s)*

---

## 9. Quantity

**Show:** The numeric pad. Tap a chip, then type a number.

**Say:**
> Big numeric pad, a default of one, and plus-one, plus-five, plus-ten chips for
> the common cases.
>
> A short story about this pad. In the reference build it used its own default
> as a prefix — so tapping "2" on a pad showing "1" booked twelve. Every API
> test passed the whole time, and correctly: the API was never asked for twelve,
> the screen sent it. It took driving the actual screens in a browser to find.
> That is why there is now a UI test that does exactly that.

*(~30 s, optional)*

---

## 10. The optional step

**Show:** Machine picker, reason chips, and the SKIP button.

**Say:**
> Machine and reason are optional, and the skip button is as prominent as
> anything else on the screen. Skipping must never be slower than filling in —
> the moment it is, people stop using the system entirely and you have a
> notebook again.
>
> When they do fill it in, this is what powers the by-machine report: new job,
> breakage, wear, trial, rework.

*(~25 s)*

---

## 11. Splitting one item across machines

**Show:** The split screen.

**Say:**
> One more thing this step can do. Ten inserts taken out, but four for one
> machine and six for another. Split it here and you get one ledger row per
> machine — separate lines, one transaction, so the stock check applies to the
> total rather than to each piece of it.

*(~20 s)*

---

## 12. Confirm

**Show:** The one-line summary and the CONFIRM button.

**Say:**
> One line, one button. Read it back, confirm.
>
> Note where "back" is: the bottom bar, mirroring the settings gear at
> bottom-right. A six-and-a-half-inch phone puts the top-left corner outside
> thumb reach, so a back button up there means a second hand — with gloves on,
> next to a machine.

*(~20 s)*

---

## 13. Success — and the alert

**Show:** The success screen, ideally on an item that crosses its reorder level.

**Say:**
> Done. And here is the number that makes this worth doing: on hand was forty,
> and it is now thirty-eight. Not "recorded" — recalculated.
>
> When a movement pushes an item below its reorder level, the screen says so
> immediately: this item is now LOW, the storekeeper has been notified. The
> person who took the last few is the person best placed to know, and they are
> told while they are still standing there.
>
> Fifteen seconds later the screen returns to idle, ready for the next person.

*(~30 s)*

---

## 14. When the network is gone

**Show:** Turn off wifi, complete an issue, show the pending marker, turn wifi
back on, show it flush.

**Say:**
> Take the network away mid-transaction and the terminal keeps accepting work.
> Movements queue in the browser's own storage, visibly marked as pending, and
> flush when the connection comes back.
>
> Each queued movement carries an id generated once, before the first attempt,
> and never regenerated. So if the request actually committed and only the
> acknowledgement was lost, the replay resolves to the same receipt rather than
> booking the stock twice — which is the failure that would make an operator
> re-enter it by hand and deduct it a third time.
>
> Being honest about the limit: the terminal can keep *writing* offline. It
> cannot *read* — a lookup or an on-hand figure needs the server, and on the
> cloud deployment the server is across the internet rather than across the
> room.

*(~40 s)*

---

## 15. Live view

**Show:** The read-only dashboard, three tabs.

**Say:**
> Same app, read-only. Activity as it happens, current stock, open alerts. It
> refreshes on its own, so you can put it on a screen in the office and watch
> the crib.
>
> It moves no stock. Nothing on this screen can write a row.

*(~20 s)*

---

## 16. Admin sign-in

**Show:** The admin login screen.

**Say:**
> The console is behind an operator login — employee code and PIN — and it is
> gated to storekeepers and admins.
>
> One deliberate exception, which took a user asking to spot: an ordinary
> operator now has their own sign-in page. Not the console — there is nothing in
> there that belongs to them — just the one thing that does: which of their own
> devices may sign in as them, and how to forget one they have lost.

*(~25 s)*

---

## 17. Console → Catalog

**Show:** The catalog list, then open one item.

**Say:**
> The catalog. Item code, description, bin, on hand — sortable by any of those,
> and sorted on the server, so the arrow ranks the whole table rather than
> reordering the page you happen to be looking at.
>
> Open an item and you get the tooling detail this is actually for: ISO code,
> grade, manufacturer and their part number, diameter, flutes. Then the stock
> policy — reorder level, order quantity, bin, unit cost, and the value sitting
> on the shelf. And whether this item is allowed to go below zero, which most
> are not.

*(~35 s)*

---

## 18. Serials and labels

**Show:** The Serials button on a catalog row, then a printed label sheet.

**Say:**
> Every physical sticker gets a serial. Not one per item — one per tool on the
> shelf. TC-000001, TC-000002.
>
> And a reprint is the same number again. The print count goes up; no new row,
> no new number. Reprinting a lost sticker must not give one physical drill two
> identities, or you end up with two shelves both claiming to hold the same
> tool.
>
> Print a batch as a PDF and the labels are Code 128 of the item code — which is
> the same thing the terminal's camera reads. Print it, stick it on the bin,
> scan it. That round trip is tested: we rasterise the label at print
> resolution, decode it back, and check it resolves to the item it came from.

*(~40 s)*

---

## 19. Console → Stock

**Show:** The stock view with the low and empty filters.

**Say:**
> Stock, filterable by low, empty, category or bin. This is the ordering screen.
>
> Every one of these numbers is derived. There is no quantity column anybody can
> type into — and I will come back to why that is the most important decision in
> the whole system.

*(~20 s)*

---

## 20. Console → Alerts

**Show:** The alert list; acknowledge one, edit a reorder level inline.

**Say:**
> Alerts, with the level editable inline — because the moment you look at an
> alert is the moment you know whether the threshold was right.
>
> Acknowledging is not resolving. An acknowledged alert is one somebody has
> seen; it resolves when stock actually comes back above the line. Those are
> different facts, and the screen keeps them apart.

*(~25 s)*

---

## 21. Console → Ledger

**Show:** The ledger list, then open one row.

**Say:**
> This is the audit trail, and it is the thing the whole system exists to
> produce. Filter by item, by person, by machine, by date.
>
> Open a row and you get everything: the row number, the type, the quantity,
> when it was booked, who booked it, on which machine, for what reason, the unit
> cost at the time, and the line value.
>
> And notice this field — "corrects". A mistake here is never edited and never
> deleted. It is corrected by inserting a reversing row that points at the
> original. Both rows stay. The database physically refuses an update or a
> delete on this table — that is a trigger, not a convention, and not something
> the application could bypass even if it wanted to.

*(~40 s)*

---

## 22. Console → Reports

**Show:** Consumption, then By machine, then By person. Change the grouping and
the date preset. Hit the CSV export.

**Say:**
> Consumption, grouped by machine, item, category, person or month, over thirty
> days, this month, this year, or all time. Export any of it as CSV.
>
> By machine answers the question a production manager actually asks: which
> machine is eating tooling, and which tools is it eating. Movements booked
> without a machine are kept and labelled rather than quietly dropped — because
> the optional step is optional, and a report that hides what was skipped is
> lying by omission.
>
> By person is not a productivity metric. Look at the chips: how many of that
> person's sessions came from the door, how many from a registered phone, how
> many from a typed PIN. That is the identity quality of your audit trail, per
> person. If somebody's column is all typed PINs, their fingerprint is not
> enrolled at the door — and that is worth knowing before you need the trail.

*(~45 s)*

---

## 23. Console → Setup

**Show:** The Setup list — six entries.

**Say:**
> Setup is six things, and each one is the master data behind a screen you have
> already seen.
>
> **People** — who can take stock out, and what they may do. Admin only.
>
> **Machines** — the picker on the optional step, and the axis of the by-machine
> report.
>
> **Reasons** — why stock moved, when anybody bothers to say.
>
> **Door** — is the reader still talking to us, and what has it sent.
>
> **Fingerprint sign-in** — which of your devices may sign in as you, and
> forgetting one you have lost.
>
> **Printer** — label size, and whether printing goes through the browser or a
> small agent inside the plant.

*(~35 s)*

---

## 24. Setup → People

**Show:** The People list, then the add form.

**Say:**
> Add a person: employee code, name, department, role, and the id they are
> programmed with on the door terminal.
>
> The first thing every single user asks for is a fingerprint field on this
> form. There cannot be one, and the form says so rather than leaving you
> guessing. The door's fingerprint template belongs to the door terminal — it
> captures it, it matches it, and all we ever hold is the mapping to an employee
> code. A phone's fingerprint unlocks a key held in that phone's own hardware,
> so nobody can register it on somebody else's behalf. Three different things,
> enrolled in three different places, by three different people.
>
> And nobody is ever deleted here. They are deactivated. Every one of these rows
> is pointed at by the ledger, and the ledger's promise to still answer "who
> took the forty inserts" lasts exactly as long as those rows do.
>
> One guard worth naming: the last active admin cannot be removed or demoted. If
> they could, nothing left in the product could create the person who would fix
> it.

*(~50 s)*

---

## 25. Setup → Door

**Show:** The device list with "last heard", then a punch with both timestamps.

**Say:**
> This screen exists to catch silence.
>
> Remember, our software does not open the door and never did. So when the
> device stops talking to us — powered off, network moved, address changed — the
> door keeps working perfectly and the store just quietly stops recording who
> came in. Nobody is inconvenienced enough to report it.
>
> So the number that matters here is "last heard", and it is shown as an age.
> "Four days ago" is a judgement. A raw timestamp is homework.
>
> And each punch shows two clocks: what the device claimed, and what we
> observed. Business logic always uses ours — some of these terminals silently
> drift off the half-hour offset — and a gap between the two columns is how you
> see that happening.

*(~40 s)*

---

## 26. Setup → Printer *(optional)*

**Show:** The printer settings form.

**Say:**
> Label size, resolution, and how printing happens: straight through the browser
> print dialogue, or handed to a small agent running inside the plant when the
> printer is on the local network. A browser cannot open a socket to a label
> printer, and a function running in the cloud has no route to a private
> address — so that agent is the honest answer rather than a workaround.

*(~20 s)*

---

## 27. The one rule underneath all of it

**Show:** Back on the ledger, or a slide with the single sentence.

**Say:**
> Everything you have just seen rests on one decision.
>
> Stock is never stored as a number you update. Stock is the sum of a ledger.
>
> Every movement inserts exactly one row. Nothing ever edits a quantity. The
> on-hand figure on every screen in this product is a cached total that a
> database trigger maintains, and application code only ever reads it.
>
> Two things fall out of that. First, "history" and "current stock" become the
> same object, so they cannot quietly disagree with each other after six months
> — which is exactly what every spreadsheet in every tool crib eventually does.
> Second, there is a command that recomputes the whole ledger from scratch and
> compares. If it reports any drift at all, that is a bug in our software, not a
> data-entry problem. It runs in our test pipeline on every change.
>
> And one guard on top: an issue that would push stock below zero is refused,
> and the tablet says why — "only three left in system, count the bin and
> adjust". Not a silent failure, and not a negative number nobody believes.

*(~55 s)*

---

## 28. What it runs on *(optional — technical audience)*

**Show:** A slide, or the repository.

**Say:**
> Briefly, for anyone who cares about the stack.
>
> The deployed system is a Next.js app on Vercel with Supabase Postgres behind
> it. Nothing runs inside the plant except the door and the browsers.
>
> There is a second, complete implementation in the repository — a Rust
> workspace on Axum, with the same terminal, the same console and the same
> protocol. It is the reference build, and its migrations are the schema both
> sides run. One schema, two clients, so they cannot drift apart at the layer
> that matters.
>
> That also means an on-premise install — everything on a PC in the plant,
> working with the internet down — is still buildable from this repo. Which is
> the honest open question on the cloud version: if the line's internet drops,
> the door still opens and nothing can be booked. Worth deciding before you
> commission a real crib.
>
> The door integration is ZKTeco's ADMS push protocol — plain HTTP, tab
> separated, no vendor SDK, no Windows-only DLL. The device retries anything it
> does not get a clean acknowledgement for, so every punch is de-duplicated on
> device, user and timestamp. We have pushed the same record twice to production
> and got exactly one row.

*(~50 s)*

---

## 29. Close

**Show:** Back to the idle screen with today's movements ticking.

**Say:**
> That is ElectronIx Tool Store. A door that already works, a phone in your
> pocket, and one honest row per movement.
>
> Scan, quantity, confirm — under eight seconds — and at the end of the month
> you can finally answer where the forty inserts went.
>
> Links below. Thanks for watching.

*(~20 s)*
