# Screenshots

Drop images here when reporting a defect. Claude reads them from disk.

| Folder | What goes in it |
|---|---|
| `terminal/` | The operator flow (§12): claim, TAKE OUT / PUT IN, scan, quantity, confirm |
| `admin/`    | Admin console: Setup, People, Items, Reports, Live view |
| `print/`    | Labels and label sheets — the printed page, not the screen |
| `errors/`   | Error banners, 4xx/5xx screens, spinners that never end |
| `misc/`     | Anything else |

Naming helps but is not required. What is worth capturing along with the shot:

- **The whole screen**, not a crop of the error — the header says which screen
  and which operator.
- **The time**, if the phone shows it. Server logs are searched by window.
- **What you tapped just before**, in the filename or a message.

Everything under `screenshots/` is gitignored (`.gitkeep` and this file aside),
so a shop-floor photo never reaches the public repo.
