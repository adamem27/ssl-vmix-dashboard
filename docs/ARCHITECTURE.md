# SSL vMix Graphics Dashboard: architecture and vMix integration

> Purpose of this document: give another engineer (or another AI assistant) a fast, accurate mental model of how
> the dashboard is built and, above all, how it drives vMix and Bitfocus Companion / Stream Deck.
> It was written by reading the code at commit `d887bfa` on `main` (app version around 1.0.265, November 2026).
> File paths are relative to the repository root. When this document and the code disagree, the code wins.
> The older `README.md` is in Polish and partly out of date (for example its "Limitations" section still says there is
> no vMix control); this file describes the current state.

---

## 1. What the system is

A local web app for the graphics operator of the SSL (Star Sailors League) sailing broadcasts, for example SSL Gold Cup 2026.
It does three jobs:

1. **Database of the event.** Teams (nations) with their graphics, sailors, groups ("fleets") per stage, daily crew
   declarations synced from the organiser's site, results, schedule, people (commentators, officials), tickers,
   announcements and so on. It is stored in SQLite plus a folder of files.
2. **Graphics data for vMix.** Every piece of data ends up in vMix GT titles (`.gtzip`). There are two paths:
   - **Push (main path):** the server writes title fields directly through the **vMix Web API** (`SetText`, `SetImage`)
     and brings titles in and out on **overlay channels** (`OverlayInputNIn/Out`).
   - **Pull (secondary/legacy):** an Excel workbook `ssl-vmix.xlsx` and JSON/XML endpoints that vMix Data Sources can read.
3. **Show control from two Stream Deck XL decks through Companion.** The dashboard generates the complete Companion
   configuration (pages, buttons, HTTP actions). It also keeps the button labels and colours live through Companion's HTTP API.

There are also a commentator screen (published as a static site to Cloudflare R2/S3, FTP or HTTPS), a PNG generator
(team colour gradients), a GTZIP title generator/editor, a matchboard PNG renderer and a DRAW screen (a vMix Browser input).

### Tech stack

```
server/   Node 22 + TypeScript, Fastify, better-sqlite3, zod, cheerio; tests with vitest (server/test)
  src/index.ts            boot: DB, migrations, background timers (sync, workbook, generator, lower thirds, show, live feed, static site)
  src/app.ts              REST API (/api/...), JSON/XML feeds (/json/..., /xml/all), auth hook, serves the built UI
  src/db/                 SQLite schema + migrations (tables: events, teams, sailors, assets, fleet_sets, fleets,
                          fleet_slots, declarations, declaration_members, sync_runs, people, schedule_items,
                          graphic_sets, lineups, results, race_runs, gen_*, sailor_details_rows, settings)
  src/services/show.ts    *** Show control: the vMix driver + Companion generator (the heart of the vMix integration) ***
  src/services/lowerthirds.ts   lower-third engine (team / sailor / person LTs, photo animation handling)
  src/services/vmixResults.ts   vMix URL setting, XML parser, field-name matcher, group results fields
  src/services/showData.ts      field maps for "general" boards (welcome, schedule, weather, officials, compare…)
  src/services/fieldOverrides.ts Graphics editor: per-title manual field overrides that win over dashboard data
  src/services/companionKept.ts the producer's own Companion PEOPLE page, embedded verbatim (JSON)
  src/services/gtzip/     GTZIP (vMix GT Title) reader/writer/generator
  src/services/generator/ PNG generator (team gradients, bars, panels)
  src/services/staticSite.ts, s3Target.ts, ftpTarget.ts, httpsTarget.ts, siteTargets.ts  commentator static page publishing
  src/services/liveFeed.ts      alternative: commentator screen served by an online dashboard
  src/services/workbook*.ts     ssl-vmix.xlsx writer (pull path)
  src/importers/          HTML importer for the organiser's crew declaration page (Joomla/Fabrik list)
web/      React + TypeScript + Tailwind (Vite), TanStack Query; pages in web/src/pages (ShowControl.tsx, Commentator.tsx…)
vmix-sync/vmix-sync.mjs  runs on the vMix PC when the dashboard is hosted elsewhere: mirrors files locally
windows/                 portable Windows package launcher (auto-update from GitHub releases)
```

Default address `http://127.0.0.1:4310`. Default vMix address `http://127.0.0.1:8088`, so vMix and the dashboard run on the
same PC. Both can be changed in Settings.

### Deployment topologies

| Topology | Where the DB runs | How vMix gets files |
|---|---|---|
| **A. All on the vMix PC** (the usual case at the venue; `start.bat` or the Windows package) | vMix PC | `data/assets/` is local; vMix reads the paths directly |
| **B. Dashboard on a LAN PC** (`HOST=0.0.0.0`) | another PC | share `data/assets` over SMB and set **Settings → Files & vMix paths → vMix assets root** (e.g. `\\DASH-PC\ssl-assets`) |
| **C. Dashboard online** (Docker / shared hosting, `DASHBOARD_PASSWORD` set) | server | `vmix-sync` on the vMix PC mirrors `/api/mirror/manifest` + `/api/mirror/file` every 2 s into e.g. `C:\SSL-vMix`, and sets `paths.vmixAssetsRoot` to that folder |

In every topology **the vMix Web API is called by the server process**, so the server must be able to reach vMix on
port 8088. In practice Show control is used in topology A.

### Paths that the server sends to vMix

Every picture field sent to vMix is a **path that vMix can open**. The rule (`graphicSets.imagePath`, `assets.vmixPath`) is:

- an uploaded file is stored under `data/assets/...` (`Teams/<CODE> - <name>/<CODE> - <slot>.png`, `Sailors/...`,
  `PNG generator/<CODE>/<CODE>_<file>.png`, `team-comparison/...`, `overrides/...`, `placeholders/...`);
- if `paths.vmixAssetsRoot` is set, the path becomes `<root>\<relative path>` (with the root's own separator);
- otherwise it is the absolute local path.

A re-uploaded file gets a new name (`… v2`) so that vMix does not show a cached image.

---

## 2. How the dashboard talks to vMix

### 2.1 Transport

All calls are plain HTTP GETs to the vMix Web Controller (vMix: Settings → Web Controller must be on):

```
GET {vmix}/api/                                    → full state XML (inputs, fields, values, overlays, active)
GET {vmix}/api/?Function=SetText&Input={key}&SelectedName={Field.Text}&Value={v}
GET {vmix}/api/?Function=SetImage&Input={key}&SelectedName={Field.Source}&Value={path}
GET {vmix}/api/?Function=OverlayInput{N}In&Input={key}     (N = 1..8)
GET {vmix}/api/?Function=OverlayInput{N}Out                (with the title's out animation)
GET {vmix}/api/?Function=OverlayInput{N}Off                (cut, no animation: used only for special cases)
GET {vmix}/api/?Function=Fade&Duration=500&Input={key}&Mix={m}   (break-scene clean feed on a vMix Mix, see 2.8)
GET {vmix}/api/?Function=Pause|Restart|Play&Input={key}          (rolling titles video)
GET {vmix}/api/?Function=AddInput&Value=Image|{path}  /  Browser|{url}
GET {vmix}/api/?Function=SetInputName&Input={key}&Value={name}
```

- `{vmix}` comes from the setting `vmix.apiUrl` (`vmixResults.vmixUrl`), default `http://127.0.0.1:8088`.
- Inputs are addressed by their **key (GUID)** from the XML, or by number if there is no key.
- Each call has a 4 s timeout. An unreachable vMix becomes a clear 400 error that the UI shows
  ("vMix does not answer at … Turn on Settings → Web Controller").
- Field names always carry the GT suffix: `.Text` uses `SetText` and `.Source` uses `SetImage`. The function is
  chosen by the suffix.
- Up to 8 field calls are sent in parallel (`SET_BATCH = 8`).

### 2.2 Reading state: vMix is the source of truth

`Show.snapshot()` reads `GET /api/` (cached for 500 ms) and parses it with `parseVmixXml`:

```ts
interface VmixInput { key; number; title; type; fields: string[]; values: Record<field, currentValue> }
overlays: { "1": inputNumber|"" , … "8": … }   // from <overlay number="N">inputNumber</overlay>
```

**What is on air is never remembered from key presses. It is always read from vMix.** This is why the decks stay correct
even when the operator also clicks in vMix itself. UNDO stores snapshots of the overlay map (up to 20) and restores them
with `OverlayInputNIn/Out`. The UNDO key was later taken off the decks, but the action still exists.

### 2.3 Diff-only writes

`Show.set(input, fields)` → `setOne()`:

1. Applies **Graphics editor overrides** first (`withOverrides`). A field the producer typed by hand in the dashboard's
   Graphics editor always wins.
2. Maps each wanted field to the title's real field name with `titleFieldMatcher` (2.5).
3. **Skips every field whose value already equals what vMix shows** (`input.values`). A key press therefore usually
   sends nothing, because the background data sync has already filled the title, and the graphic comes in instantly.
   It also means that when a title is already on air, only the changed fields are sent, so the GT **DataChange**
   animations play instead of a full out and in.
4. Writes back into the cached `values` so the next `set()` before the next XML read stays correct.
5. Then repeats the same for every **copy** of the input (2.4).

### 2.4 Copies of a title (virtual inputs, duplicates)

`copiesOf(input, inputs)` in `show.ts`: any other input whose title (lower case, without `.gtzip`) matches

```
^(<base>|(virtual|copy)\W*<base>)([\s(\-–]+(virtual|copy|\d+)\)?)*$
```

For example `ssl_schedule - Virtual`, `ssl_schedule (2)`, `Virtual ssl_schedule`, `ssl_schedule Copy`.
`ssl_results_group_4` is **not** a copy of `ssl_results_group`. Every copy gets the same data. A vMix *virtual input*
lists no fields in the XML, so all fields are sent to it, using the original's field names. Copies exist so the same
board can appear in another Mix (clean feed) without playing its animations twice.

### 2.5 Field-name matching (`titleFieldMatcher`)

The dashboard produces a superset of field names, and only the fields the title really has are sent. Matching order:

1. exact, case-insensitive (`POS 1.Text` ↔ `pos 1.Text`);
2. "loose": letters and digits only (`Air °C.Text` ↔ `AIR C.Text` / `Air_C.Text`);
3. **GT Title Designer truncation**: GT cuts element names at 15 characters (`TacticianSURNAME` → `TacticianSURNAM.Text`),
   so a longer wanted name matches a 15+ character title field it starts with, with the same suffix.

Because of this, one field map serves many variants of the same graphic (for example results titles named either
`POS n / TEAM n / R1 n / POINTS n` or `position n / COUNTRYn / R1 pointsn / Totaln`).

### 2.6 Input naming conventions (the registry)

Show control finds every graphic **by input name** in vMix (`DEFAULT_GRAPHICS` in `show.ts`). The names can be changed
per graphic in the Show control tab (comma-separated alternatives, tried in order). Matching ignores case and a trailing
`.gtzip`. A real title (one with fields) is preferred over a placeholder image of the same name.

| id | Input name(s) tried | Kind | Overlay |
|---|---|---|---|
| welcome | `ssl_welcome` | board | 1 |
| schedule | `ssl_schedule` | board | 1 |
| matchboard | `ssl_matchboard` | board | 1 |
| results | `ssl_results_group_{n}`, `ssl_results_group` ({n} = teams in the race, 3/4) | board | 1 |
| compare | `ssl_compare_{n}`, `ssl_compare` | board | 1 |
| lineup | `ssl_lineup_{crew}`, `ssl_lineup` ({crew} = crew size; the nearest bigger, then smaller, title is used) | board | 1 |
| course | `ssl_course` | board | 1 |
| officials | `ssl_officials` | board | 1 |
| weather | `ssl_weather` | board | 1 |
| teamq | `ssl_lt_team_q` (team LT "QUALIFIED FOR THE FINAL SERIES") | lt | 1 (LT overlay) |
| comm | `ssl_lt_comm_photo`, `ssl_lt_comm_nophoto` (people / commentators) | lt | 1 |
| lineup5 | `ssl_lt_lineup5` (lineup lower third, 5 + 4 sailors) | lt | 1 |
| bug | `ssl_bug` (aliases `Announcement_bug`, `Announcement_bug_flag`) | bug | 1 |
| ticker | `ssl_ticker` | bug | 1 (or the break ticker channel) |
| tickertop | `ssl_ticker_top` | bug | `tickerTopLayer` (default 2) |
| socials | `ssl_socials` | bug | 1 |
| sponsors | `ssl_sponsors` | bug | 1 |
| break | (no input: a combination, see 2.8) | scene | 4 |
| lbar | `ssl_lbar` (aliases `L-bars`, `L-bar`, `Lbar`) | scene | 1 (2 in the break scene) |
| lbar2 | `ssl_bar_2` (L-bar ranking) | scene | 1 |
| titles | `Rolling_Titles` (video) | bug | 8 |

**Per-group inputs** (derived from the groups of the stage picked in the dashboard header; `compareKey(name)` gives
A, B… for groups, `LCR` for Last Chance Race, `QR` for Qualification Race):

- `ssl_results_<KEY>` (e.g. `ssl_results_A`, `ssl_results_LCR`): the group's own results title. If it is missing, the
  shared `ssl_results_group*` gets that group's data.
- `ssl_compare_<KEY>` (e.g. `ssl_compare_A`, `ssl_compare_QR`): Team comparison per group. If it is missing, the shared
  `ssl_compare*` is used.

**Lower thirds** (separate engine, `lowerthirds.ts`, names set in Show control → Lower thirds):
`lowerthird_photo` (sailor with photo) and `lowerthird_no_photo` (team, and sailor without photo).

**Other:** `ssl_draw` (vMix Browser input with `/draw/output`), `ssl_draw_matchboard` (Image input), and any title with a
`Swap.Source` field (L-bar switch, 2.10).

"Add placeholders" (`POST /api/show/placeholders`) adds every missing registry input to vMix as an Image input
(a transparent 1920×1080 PNG with an orange corner mark) and names it. The operator later replaces it with the real GTZIP
under the same name. Apart from adding inputs, the dashboard never changes vMix configuration (outputs, mixes, layers).

### 2.7 Overlay channel rules

Implemented in `Show.bringIn()`, `toggle()` and `sceneOut()`:

- **Everything goes on overlay 1 (OV1)**: boards, lower thirds, bugs, the bottom ticker. A new graphic on OV1
  simply replaces the previous one, and vMix plays the transitions.
- A **board** coming in first takes off the lower-third channel (if different) and **takes the break scene off**.
- A **scene** (break, L-bar) takes off OV1 and the LT channel and stops the break rotation.
- **Toggle semantics:** pressing a graphic's key while that same input is on its overlay takes it **out**.
- Lower thirds on OV1: a sailor key while another LT is on air does **not** take it out. It only changes the data
  (DataChange), which avoids the photo fly-out delay. A board on OV1 is taken out first.
- `OUT` (`layerOut`) takes OV1 out. If it is a lower third, it goes through the LT engine so that the photo flies down
  first. `ALL OUT` takes every overlay 1–8 out with animations. `PANIC` (two presses within 3 s, `OverlayInput1..4Off`)
  still exists as an action but is no longer on the decks.
- Top ticker on `tickerTopLayer` (default 2). Rolling titles on 8: `Pause` + `Restart`, in on OV8, then `Play` 3 s later.

### 2.8 Break scene

There is no `ssl_break` input any more. The break scene is **three inputs on three overlay channels**, each with its
own in and out animation (config `breakLbarLayer` = 2, `breakTickerLayer` = 3, `breakBoardLayer` = 4):

1. L-bar (`ssl_lbar`) on channel 2,
2. ticker (`ssl_ticker`) on channel 3, with the ticker version picked last or the automatic one
   ("next race" / "end of day"),
3. a board on channel 4 that **rotates**: day schedule (optional, `breakSchedule`), then each selected group's results
   (`breakFleets`; if none are picked, every group except the Last Chance Race).

The rotation (`startRotation`, every `rotateSeconds`, default 30) works like this: the board goes `OverlayInput4Out`,
the server waits `breakOutMs` (1.5 s) for the out animation, sets the next group's data, then `OverlayInput4In`.
While a board is switching, the background sync does not touch it (`switching` flag). Ticker keys during the break
take the ticker out, change the text and bring it back in. `BREAK OUT` takes all three channels out.
"Break on air" means the L-bar is on its channel, or the schedule or any results input is on the board channel.

**Clean break on a vMix Mix (`breakMix`, 2–16, 0 = off; the latest feature):** each time a board enters the break
scene (start or rotation), the server also does `Fade&Duration=500&Input=<copy>&Mix=<breakMix-1>` (the API's `Mix`
is 0-based, so Mix 2 = `Mix=1`). It prefers a **copy** of the board (a title with `virtual`, `mix` or `clean` in its
name, else any copy, else the board itself), so the board's in and out animations on the program output do not play
in that Mix. The Mix gets the boards **without the ticker**. The L-bar for that feed is expected to be a layer of the
Mix's input, set up inside vMix.

### 2.9 Background data sync (titles stay current without key presses)

`Show.start()` runs every 2 s: `pushLabels()` (Companion), `syncData()` and `lbarSwap()`.

`syncData()` runs only when the database changed (`SELECT total_changes()`) or the day changed. It reads vMix and
diff-writes:

- `ssl_welcome`, `ssl_schedule`, `ssl_weather`, `ssl_officials`, `ssl_socials` ← `showDataFields(...)` (General graphics tab);
- the shared results title ← the group picked at the top, or the break scene's current group while the break is on air;
- every `ssl_results_<KEY>` ← its group; every `ssl_compare_<KEY>` (and the shared compare) ← its group;
- every other title that has Graphics-editor overrides ← those overrides.

Because of this sync, a key press normally only does `OverlayInputNIn`.

Pictures are **not** re-sent when only the file content changed (same path). The **REFRESH PNG** key
(`refreshPictures`) re-sends `SetImage` with the same path for every `.Source` that points into the dashboard's assets
folder, which forces vMix to reload a PNG remade in the PNG generator. The matchboard is reloaded automatically after
each export (`reloadMatchboard`, again 3 s later for the mirrored copy).

### 2.10 Other vMix behaviours worth knowing

- **Lower thirds (`lowerthirds.ts`)**: one GT title for teams and sailors. Team: Top text = country, Bottom text = nickname.
  Sailor: Top = first name + LAST NAME, Bottom = number | position, and `NEXT RESULT` cycles the bottom line through the
  sailor's best results (data change only). Pictures: Bar, Flag, Emblem, PHOTO, plus the team's sponsor tab.
  Photo handling: vMix does not play a Fly on the photo during Transition In, so the title comes in with an empty photo
  and the photo is set just after. It then rises with its DataChange. On OUT the photo is cleared first, and the title
  goes out after the photo's out time. Photo mode (AUTO/ON/OFF) can force the no-photo title.
- **Lineup board (`ssl_lineup_{crew}`)**: fields per place (`HelmNAME`, `HelmSURNAME`, `HelmNUMBER`, `HelmPOSITION`,
  `HelmPHOTO`…, truncated by GT), or numbered boards `S1NAME…S12PHOTO` filled bow to stern. The `BG.Source` panel is
  swapped to a generated "Lineup sponsor panel" only for teams with sponsor logos. The original BG is remembered per
  title and put back for the next team.
- **Lineup LT (`ssl_lt_lineup5`)**: places 1–5 for a screen of five, 6–9 for a screen of four (`NAME n`, `POSITION n`,
  `PHOTO n`, `Bar.Source`). `LINEUP LT 5 ⇄ 4` swaps the halves as a data change.
- **Team comparison**: FLAG ⇄ EMBLEM toggle. Flag 4 is sent first (it triggers the title's DataChange), then the others
  after `flagChangeMs`, so all flags change inside the animation.
- **Announcement bug**: `TEXT` + an icon field (`Race flag`, `icon`, `FLAG`…). If vMix lists no fields for a GT title,
  the server sends "blind" by the GTZIP's known field names.
- **L-bar switch**: a title with `Swap.Source` alternates every `lbarSwapSeconds` (8 s) while it is live (on any overlay
  or on the program, `<active>`). It switches between an empty PNG and a "difference" PNG computed from two uploaded
  L-bar looks, so only the changed parts cross-fade through the DataChange.
- **Results "Send to vMix"** (Results tab, `POST /api/results/:fleetId/vmix`): a one-shot push of a group into any
  named input, independent of Show control. Race columns are right-aligned next to Points.
- **Graphics editor** (`/api/vmix/editor*`): lists the vMix titles and lets the producer type over any text or picture
  field. Edits are stored per title name and field (`inputs.overrides`) and win everywhere the dashboard writes.
- **DRAW**: `POST /api/draw/vmix-input` adds a Browser input `ssl_draw` pointing at `/draw/output` (no login needed for
  that page); `ssl_draw_matchboard` is an Image input refreshed with `SetImage`.

### 2.11 One vMix or several?

The dashboard server talks to **exactly one vMix** (`vmix.apiUrl`). Control of other vMix machines (for example a
separate **stream vMix**) and of the ATEM is done **by Companion itself**, through Companion's own module connections:

- The producer's hand-made **PEOPLE** page (`companionKept.ts`, embedded verbatim) contains three Companion connections:
  `ssl_dashboard_show` (generic-http → this dashboard), **`vmix_stream1`** (studiocoast-vmix module → the stream vMix)
  and `atem` (bmd-atem).
- On that page, row 1/2 keys are `vmix_stream1` `overlayFunctions` (for example input 15 on overlay 1, named "Yann ENG").
  These are language-specific commentator LTs fired directly on the stream vMix, with vMix tally feedback.
  The `atem` key `dskAuto` is the ATEM downstream key.
- The generated preset **keeps those connections and keys untouched** and copies the ATEM **DSK** key onto every page
  (the bottom row's last place, where PANIC used to be).

So in a multi-vMix setup the dashboard fills and switches graphics on the vMix whose URL is configured. Companion talks
to the other vMix directly. If the second vMix should show the same boards, give it inputs with the same names
and point a second dashboard instance at it, or use the copies mechanism (2.4) inside one vMix.

---

## 3. Companion / Stream Deck generation

### 3.1 Concept: keys call their *place*, not an action

Every generated button is a Companion `generic-http` **GET** to

```
{dashboard}/api/show/key/{page}/{row}/{col}
```

The server looks up which action that place has **now** (`Show.keyAt` → `runKey`) and runs it. Changing a key in the
dashboard's key editor, adding a team, a ticker, an announcement or a person therefore needs **no re-import** in
Companion. Only navigation keys are native Companion `set_page` actions (page changes happen in Companion).
Older presets used `/api/show/do?a=<action>`, which still works.

Labels and colours are pushed live: every 2 s, after every key press and after config saves, `pushLabels()` POSTs
**only the changed** keys to Companion's HTTP remote control (Companion 3+):

```
POST {companionUrl}/api/location/{page}/{row}/{col}/style?text=…&bgcolor=#rrggbb&color=#rrggbb&size=auto
```

A `204` means Companion has no button there (old preset). Places the dashboard wrote earlier but no longer uses are
blanked. Pushed colours are **fixed** (no on-air red in Companion), and the ATEM DSK key only gets its text ("DSK").
`companionUrl` is set in Show control (e.g. `http://127.0.0.1:8000`).

### 3.2 Downloads

- `GET /api/show/preset.companionconfig?base=<dashboard url>&vmix=<vmix url>`: **one full Companion export**
  (format version 12, Companion 5.1.2, `type: "full"`). It holds all pages, the `ssl_dashboard_show` generic-http
  connection, and the producer's `vmix_stream1` and `atem` connections. Import it in Companion → Import/Export.
- `GET /api/show/companion` and `/api/show/companion/:name`: single page exports.
- `GET /api/lt/companion/:n`: older standalone lower-third pages (Companion 3.2 export format 4); keys call
  `/api/lt/key/{page}/{row}/{col}`.
- `GET /api/draw/companion.companionconfig`: the DRAW page.

`base` defaults to the request's host. Generated buttons are Companion 5.1 `button-layered` controls (a box layer
and a text layer, `canModifyStyleInApis: true` so the style API can relabel them).

### 3.3 Page layout (`defaultDeckPages`, `PRESET_PAGES`)

Grid 8 × 4 (Stream Deck XL). Row 3 (the bottom row) of every page is navigation: HOME or the other pages of that deck,
FALLBACK, PHOTO MODE (on team and PEOPLE pages), ALL OUT, then the ATEM DSK key.

| Page | Deck | Name | Content |
|---|---|---|---|
| 1 | 1 | A BEFORE | WELCOME, MATCHBOARD, DAY SCHEDULE, RACE COURSE, OFFICIALS, WEATHER, SOCIALS; REFRESH PNG |
| 2 | 1 | C-E AFTER / BREAK | SOCIALS, L-BAR, L-BAR RANKING, SPONSORS BAR, TITLES; BREAK SCENE, BREAK OUT, AUTO SWITCH, NEXT SLIDE, TICKER ON/OFF, TOP TICKER ON/OFF; 8 break-ticker keys |
| 3 | 2 | TEAMS | 16 places of the stage in group order (A, B on row 0; C, D on row 2); each opens its team page |
| 4 | 2 | BUGS OFTEN | announcements flagged "often", by position (`bug:oN`) |
| 5 | 2 | BUGS RARE | the other announcements (`bug:rN`) |
| 6 | 2 | TICKERS | ticker versions (`ticker:N`, 2 rows) + top ticker versions (`tickertop:N`) |
| 8 | – | FALLBACK | keys that call **vMix directly** (`{vmix}/api/?Function=OverlayInput{N}&Input=<name>`) for 15 graphics, OUT per channel, CUT ALL. It works when the dashboard is down, with the data as last set |
| 9–24 | 2 | one per team place | QUALIFIED, LINEUP, LINEUP LT, LINEUP LT 5⇄4, TEAM LT, NEXT RESULT; up to 16 crew places (`sailorof:CODE/slot`) with names; nav to the other teams of the group |
| 25 | 1 | RESULTS/COMPARE | COMPARE per group (`compare:A`…), RESULTS per group (`results:A`…), COMPARE: FLAG ⇄ EMBLEM |
| 26+ | 2 | TEAMS 2… (only if more than 16 places), then PEOPLE | PEOPLE = the producer's kept page + `person:N` keys in free places |

Sixteen team pages are always reserved, so COMPARE and PEOPLE do not move while groups fill up. An empty group place
(no team drawn yet) keeps its page, named by the place (`A1`). Pressing it returns "No team on place A1 yet".
Team and sailor keys take the team's **national colours** (`nationColours.ts`).

### 3.4 Action vocabulary (`Show.dispatch`)

`show:<id>` (toggle a registry graphic), `compare:<KEY>`, `results:<KEY>`, `lineup:<CODE|n>`, `lult:<CODE>`,
`lultswap`, `qualified:<CODE>`, `teamlt:<CODE>`, `anthem:<CODE>`, `sailorof:<CODE>/<slot>`, `sailor:<n>`,
`shirt:<number>`, `boat:<n>`, `person:<n>`, `comm:host|guest|water`, `bug:<oN|rN|id>`, `bugout`, `ticker:<n|id>`,
`tickertop:<n>`, `breakticker:<n>`, `nextticker`, `tickermode`, `breakout`, `rotate`, `nextslide`, `comparemark`,
`photo`, `next`, `out`, `allout`, `undo`, `panic`, `refreshpng`, `nav:<page>`.

Key edits (Show control's key editor) are stored by **page name** (`"PUR/0/2"`) in `show.config.keys`: action, text
(`{auto}` = live text), bg and fg colours. Per-kind colours are in `kindColours`.

### 3.5 Useful direct URLs (for Companion or testing)

```
/api/show/key/{page}/{row}/{col}        what a Companion key does
/api/show/do?a=show:schedule            any action by name
/api/lt/team?team=POL   /api/lt/sailor?team=POL&place=Helm   /api/lt/next   /api/lt/out
/api/draw/do?...                        DRAW steps
GET /api/show                           full Show control view (config, state, vMix overlays, pages with live looks)
```

---

## 4. Data sources

| Source | How it enters | Where it is used |
|---|---|---|
| Organiser's crew declaration page (Joomla/Fabrik HTML list) | `sync.ts` fetches every 30 min (configurable), or the operator uploads a saved HTML file; parser `importers/sslFabrikCrewList.ts` finds the table by header text | daily declarations → line-ups, lower thirds, sailors sheet |
| Squad sheets (`.xlsx` or `.csv`, "TEAM SQUAD" forms, or one sheet with Code/Country, Family name, First name, Date of birth, Height) | `POST /api/sailor-details/import` (`sailorDetails.ts`, its own minimal xlsx reader); unmatched people are assigned by hand | age and height for the commentator screen |
| Event squads, crews, rooming | JSON fixtures in `server/fixtures/` applied once by migrations or seed scripts (`seed:goldcup`) | teams, sailors, line-ups |
| SSL nation ranking | `ranking.ts` fetches worldofsailors.com (operator override kept separately) | Teams sheet, Team comparison |
| Team graphics | uploads per team slot (`background_1/2`, `emblem_dark/light`, `flag_small/big` (auto-rounded corners), `lowerthird_photo/anthem`, `sponsor_1…5`), bundled flags and emblems, PNG generator output | every title |
| General graphics | forms in the dashboard (`graphic_sets`: welcome, tickers, top tickers, announcements, officials, socials, course; plus people, schedule, weather) | showData field maps |
| Results | typed in the Results tab per group (races, points) | results titles, commentator screen |
| GTZIP templates | uploaded `.gtzip` / zips into `data/gtzip-templates` (never modified); the GTZIP generator writes new titles to `assets/gtzip/<name>.gtzip` (refuses to overwrite) | loaded into vMix by the operator |

### 4.1 Pull path for vMix (secondary)

- `ssl-vmix.xlsx` (path `WORKBOOK_FILE`, default `data/assets/ssl-vmix.xlsx`) is rewritten within about 3 s of any DB
  change. Sheets: General, Teams, Sailors, Line-up, Results, Announcements, People. Teams/Sailors/Results cover the
  stage picked in the header. Use it in vMix as Data Sources → Excel.
- `/json/teams`, `/json/sailors`, `/json/fleets/:id`, `/json/captains`, `/json/weather`, `/json/schedule`,
  `/json/people`, `/json/results`, `/json/lineups`, `/json/graphics`, `/json/sheet/:key`, `/json/all`, and
  `/xml/all` (XPath `//sheet[@name='Teams']/row`). These are flat rows of strings, and picture fields hold vMix paths.

The push path (section 2) is what the live show uses. The pull path exists for titles mapped by hand through Data Sources.

### 4.2 GTZIP generator / title tooling

`server/src/services/gtzip/` reads and writes vMix GT Title packages byte-compatibly with GT Title Designer: a stored
zip with `document.xml` (UTF-16 declaration, CRLF), `resources.xml`, `[Content_Types].xml`, image parts by GUID and
`thumbnail.png`. The generator can rename and add fields, duplicate elements (extra line-up places `Sailor10…`),
embed PNGs, fit texts (`textFit.ts`) and tidy storyboards (TransitionIn/Out, DataChange). The SSL26 titles in the
project (e.g. `Lineup_lowerthird_9.gtzip`, `Team_lineup_8/9.gtzip`, `ssl_results_A–D`, `ssl_compare_A–D`,
`day_schedule_*`, `Race_officials_*`) were produced with it. **Field names in these titles are the contract** with
the field maps in `show.ts`, `showData.ts`, `vmixResults.ts`, `lineups.ts` and `lowerthirds.ts`.

---

## 5. Commentator screen publishing

The commentator screen (`web/commentator.html`, page `Commentator.tsx`) shows fleets, crews, results, notes for
commentators, schedule and an optional tracking iframe. There are two ways to get it to remote commentators.

### 5.1 Static site (recommended): `staticSite.ts`

Every 5 s the venue dashboard checks whether to publish. The routine publish runs **every 5 minutes**
(`publishEveryMs = 300 000`). "Publish now" and settings changes publish immediately. After a failure it backs off
5 s → 10 s → … → 5 min. Each round builds a folder `komentator-<random>/` containing:

```
index.html, assets/*.js|css   the built screen
data.json                     all data the screen needs, picture URLs pointing at img/
img/<sha1>.png|jpg            flags, emblems, photos (content-addressed)
status.json                   { pushedAt, version, auto }  (written every round; the page polls it, ~3 s,
                              ?refresh=<s>, and fetches data.json only when version changes)
```

Only changed files are uploaded, in order: pictures and scripts, then data.json, then status.json. The random folder
name is the access key, and the page cannot change anything.

Targets (`siteTargets.ts`):

- **Cloudflare R2 / any S3** (`s3Target.ts`): a signed `PUT` per object with AWS Signature V4 (no SDK). Settings:
  endpoint `https://<account>.r2.cloudflarestorage.com` (a pasted `/bucket` suffix is accepted), bucket, access key,
  secret, and the public base URL (`https://pub-….r2.dev` or a custom domain). Data files get `Cache-Control: no-cache`;
  hashed assets and images are cached for a year. Link: `<public>/komentator-xxxx/index.html`.
- **HTTPS to `upload.php`**: the dashboard generates the PHP file (`GET /api/static-site/upload.php`) with a hash of
  this PC's key. It accepts only the page's own files and writes atomically.
- **FTP/FTPS** (`ftpTarget.ts`) and **local folder only**.

An open PR (#27, branch `commentator-cleanup`, not merged at the time of writing) narrows this to R2 only on
`commentary.em27code.com` with new data every minute. Check `main` before relying on the list above.

### 5.2 Online dashboard live feed (alternative): `liveFeed.ts`

The venue PC pushes (every 5 s, gzip, heartbeat when nothing changed) the JSON answers of a handful of GET routes plus
blobs to an online instance (`/api/live-feed/push`, `/api/live-feed/blob/:hash`, which needs that instance's
`DASHBOARD_PASSWORD`). Viewers open `/c/<token>`. That sets a read-only cookie, and only commentator routes are allowed
(everything else returns 403 or redirects to `/live`). "New link" rotates the token.

---

## 6. Security model (short)

- No login when `DASHBOARD_PASSWORD` is unset. That is the intended setup at the venue on `127.0.0.1` or a trusted LAN.
- With a password: a cookie or HTTP Basic login. Exempt from login: `/api/health`, `/login`, `/c/:token`, the DRAW
  output page and its assets (for the vMix Browser input), and internal requests with the `x-ssl-internal` key.
- Companion calls the dashboard with plain GETs and no authentication, so Show control assumes a local or trusted network.

---

## 7. Background timers (from `server/src/index.ts`)

| Timer | Interval | Job |
|---|---|---|
| `sync` | checks every 15 s, runs per configured interval (default 30 min) | declaration import |
| `workbook` | 3 s (rebuild only on DB change, or every 30 s for clock-based fields) | `ssl-vmix.xlsx` |
| `generator` | a few seconds after changes | PNG generator auto-export |
| `show` | 2 s | Companion labels, vMix data sync, L-bar switch |
| break rotation | `rotateSeconds` (30 s) | next board in the break scene |
| `liveFeed` | 5 s when enabled | push to the online dashboard |
| `staticSite` | 5 s tick, 5 min routine publish | commentator static page |
| `vmix-sync` (separate process on the vMix PC) | 2 s | mirror assets + xlsx + `ssl-vmix.json` |

---

## 8. State and configuration keys (SQLite `settings` table)

- `vmix.apiUrl`: the vMix Web API base.
- `paths.vmixAssetsRoot`: how vMix sees the assets folder (path mapping).
- `show.config`: the Show control config (zod `showConfigSchema` in `show.ts`): input name overrides, `fleetId`
  (the race now), break layers, groups, timings, `breakMix`, ticker defaults, `keys` (key edits), `kindColours`,
  `labels` on/off, `vmixForCompanion`.
- `show.state`: runtime state (boat, photo mode, slide, undo stack, bug, ticker and top ticker picked, lineup LT part,
  compare mark, last action and error).
- `lt.config` / LT state: lower-third inputs, overlay, picture slots, field names (`Top text`, `Bottom text`, `PHOTO`,
  `Flag`, `Emblem`, `Bar`), `companionUrl`.
- `inputs.overrides` and `inputs.overrides.before`: Graphics editor edits per title, and the original values.
- `static.*`, live-feed settings, `sync.*`: publishing and import.

Config migrations happen on read (`getShowConfig` with `cfgVersion`). Old position-based key edits are migrated to
name-based ones once.

---

## 9. Quick troubleshooting map

| Symptom | Where to look |
|---|---|
| "vMix has no input X for Y" | the input name in vMix vs. the registry (2.6); "Add placeholders" |
| "takes none of the data" | the title's field names vs. the field map; GT 15-character truncation; a placeholder image named like the title (delete it) |
| a key does nothing new after a PNG change | REFRESH PNG key (2.9) |
| Stream Deck labels stale | Show control → Companion panel: address, "labels" switch, "push now"; a 204 means re-import the preset |
| board shows the wrong group | the group picked at the top of Show control (`fleetId`) and the stage picked in the header |
| clean-feed Mix shows animations | give the board a copy named `… - Virtual` / `… clean` (2.4, 2.8) |
| dashboard down during the show | the FALLBACK page (page 8) drives vMix directly with the last data |
