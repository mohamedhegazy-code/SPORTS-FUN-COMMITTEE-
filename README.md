# Ahlawy — Online Registration & Points System
## أهلاوي — نظام التسجيل الإلكتروني ونظام النقاط

Al Ahly Club · Sports Entertainment Committee — Fifth Settlement
النادي الأهلي · لجنة الرياضة الترفيهية – التجمع الخامس

A working prototype of the online registration + points system described in the
committee's *Ahlawy Points System — Full Design and Implementation Plan*. It
implements: real member/staff/admin accounts, 100-point participation, +10
early-registration bonus, position bonuses for the top 6, the 7-tier
redemption ladder with tiered approval levels, the "reserved family-group
slot" design that lets family pooling switch on later with zero data
migration, and QR-code gate check-in (see below).

## Running it

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000** in a browser. The site has seven tabs:
Events (the landing page — browse upcoming events, see photos/details, and
register), Register (sign-up/log-in + confirming a registration), Member
Profile (balance, redemption requests, family members, registrations, and
a support chat with the committee, once logged in), the Redemption Ladder
(reference), Annual Activities (a look back at past events, see below),
Gate Scanner (staff/admin-only, see below), and Admin (admin-only —
events, results entry, redemption approvals, staff accounts, and the
member support inbox).

## Accounts

Every person has a real account with a username/membership-number and a
password — there are no more shared keys.

- **Members** sign up themselves on the Register tab (membership number +
  name + password). They then log in to register for events, see their own
  points balance, and request redemptions. This also closes a real security
  gap the earlier key-based version had: previously anyone could look up or
  redeem points for *any* membership number just by typing it in — now every
  action is tied to whoever is actually logged in.
- **Staff and admins** don't self-sign-up — an admin creates their accounts
  from the Admin tab ("Staff & admin accounts" panel), picking a role:
  *Staff* can only use the Gate Scanner; *Admin* can also add events, enter
  results, approve/reject redemptions, and manage other staff accounts.

**The very first time you run the app**, there are no admin accounts yet, so
it automatically creates one and prints the credentials to the terminal:

```
No staff accounts existed yet - created a first admin account:
  username: admin
  password: change-me-now
```

Log in with those on the Admin tab, then **immediately change the password**
using the "Change my password" panel there. You can override the bootstrap
username/password before first run if you'd rather not use the default at all:

```bash
ADMIN_BOOTSTRAP_USERNAME="yourname" ADMIN_BOOTSTRAP_PASSWORD="something-only-you-know" QR_SECRET="your-qr-secret" npm start
```

(`QR_SECRET` signs the QR codes so they can't be forged — change it too,
before any real event; see below.)

**Forgot password.** There's no email or SMS set up, so there's no
automatic "reset link" flow. Instead: a member who forgets their password
contacts the committee directly (phone, WhatsApp, in person) with their
membership number, and an admin resets it for them from the Admin tab's
"Reset a member's password" panel, then tells them the new password
directly. The login screen has a short reminder of this under the login
form. Staff/admin accounts don't have self-service reset either — another
admin can remove and re-add their account if they're ever locked out.

## QR-code check-in (gate scanning)

When a member registers, they get a QR code on the confirmation screen
(and can re-fetch it later if lost). **Points are only awarded once that
code is scanned at the event** — registering alone earns nothing, so
no-shows don't get credit. This matches Phase Three of the source document.

At the event, staff open the **Gate Scanner** tab on any phone's browser
(no app install needed), sign in with the staff key, tap "Start camera,"
and point it at each member's QR code. A scan instantly checks the member
in and awards their points (participation + early bonus, plus position
bonus once the admin enters results). Each code is cryptographically
signed (`QR_SECRET`) so it can't be forged, edited, or reused by someone
else after being checked in once.

If you'd rather use a dedicated barcode-scanner gun at the entrance instead
of phone cameras, that's a small follow-up change (most USB/Bluetooth
scanners just "type" the decoded text + Enter — the `/api/checkin` endpoint
already accepts raw scanned text, so it's a matter of wiring a text input
instead of the camera loop).

## Confirmations, "My Registrations" & family members (dependents)

**Booking confirmation.** The moment a member registers, they see an
in-app confirmation ("Your slot is booked!") along with their QR code right
there on the Register tab — no email/SMS setup required. If they (or a
family member) try to register again for the same event, that's not
treated as a dead-end error: if they haven't checked in yet, their
still-valid QR code is shown again right there so they don't have to go
hunting for it; if they've already checked in, a plain "no need to
register again" note is shown instead.

**Attendance confirmation with a timestamp.** When staff scan a member's
code at the Gate Scanner, the scanner shows exactly who checked in and the
full date + time of the scan (not just "checked in"). The member sees the
same thing from their own side too (next point).

**"My Registrations" (Member Profile tab).** Every member has a running
list of everything they've registered for — upcoming and past — each row
showing who's attending (self or which family member), the event, and its
status: still pending check-in, checked-in with the exact date/time it
happened, or "event finished" if it passed with no check-in. The QR code
itself is shown directly under any registration that hasn't been checked
in yet **and** whose event date hasn't passed — no extra click needed —
and disappears once either of those happens, since there's no more use for
it.

**Family members (dependents).** From the Member Profile tab's "My Family" card,
a member can add family members by name — no separate account or password
for them. When registering for an event, the Register tab shows a "Who's
attending?" checklist (the member themselves, plus each family member) so
one member can book several people for the same event in one go; each
person gets their own QR code and their own check-in. All points earned by
family members pool straight into the primary member's balance
automatically (same pooling logic as `familyGroup`, just keyed off who's
logged in rather than a shared code). Removing a family member from the
list only stops them from being selectable for *new* registrations — any
event they already attended and any points already earned stay on the
account exactly as before.

On the admin side, "Enter event results" now lists each attendee
separately (showing "(family member of ...)" where relevant) so finishing
positions can be assigned to the right person even when a member and their
family registered for the same event.

## Registration limits & the waiting list

When creating or editing an event, an admin can set a **minimum** and/or
**maximum** number of registrations — both optional, leave either blank for
no limit.

- **Maximum** actually closes registration once it's reached. The event
  stays visible everywhere (landing page, Register dropdown) marked "Full"
  rather than disappearing, but a member trying to register past that point
  isn't silently turned away either: they're shown a bilingual (EN/AR)
  message explaining the event is full and asked to explicitly confirm
  ("I understand a waiting-list spot is not a guaranteed place") before
  being added to a waiting list. Someone on the waiting list doesn't get a
  QR code yet — My Registrations shows a "Waiting list" badge instead —
  because they don't have a confirmed spot.
- **Minimum** is purely informational — shown on the admin Event dashboard
  (see below) as a target (e.g. "12/20, min target 15") so the committee
  can see at a glance whether an event needs more sign-ups. It never blocks
  or cancels anything on its own; there's no automatic mechanism that
  could — only a human deciding whether an under-subscribed event still
  runs.
- **Promoting from the waiting list**: if a confirmed spot opens up (or the
  admin raises the max), the Event dashboard's waiting-list panel lists
  everyone waiting, in the order they joined, with a "Promote to confirmed"
  button. Promoting doesn't re-check the capacity number — it's a manual
  admin judgment call, since the whole reason to promote is that the admin
  knows there's room. Once promoted, the member gets a real QR code the
  next time they open My Registrations (or their registration confirmation
  screen refreshes) and can be checked in normally at the gate. The gate
  scanner itself refuses to check in anyone still on the waiting list, with
  a clear message, so a waitlisted QR (if a member screenshots one before
  being promoted — though none is issued until they are) can't accidentally
  be scanned in as attendance.

## Parent events & sub-activities ("event days")

An event can optionally be a **parent** for any number of individual
**activities** — e.g. a "Sports Entertainment Day - New Cairo" parent event
with "Foot Volley," "Dominoes," and "Football" as its activities. This
mirrors how a real event day works: one poster/announcement, several things
people can actually sign up for underneath it.

- **Setting it up**: on the Add/Edit event admin forms, a "Parent event"
  dropdown lets you pick an existing event to nest this one under. Leave it
  on "none" for a normal standalone event (unchanged from before this
  feature existed). The dropdown only offers events that aren't themselves
  already a sub-activity — the hierarchy is intentionally exactly two levels
  deep: a parent can't be nested under another parent, and an event that
  already has activities under it can't be turned into someone else's
  activity. The number of activities per parent is unlimited and entirely up
  to whoever is setting up the event — it's not fixed at any particular
  count.
- **The parent itself is a poster, not something you register for.** Once an
  event has one or more activities nested under it, it's excluded from the
  Register tab's event dropdown and direct registration attempts are
  rejected — members register for one of the individual activities instead,
  exactly like registering for any other event today (same capacity badges,
  same waiting list, same QR code per activity).
- **Landing page**: a parent event still gets exactly one card (both in
  "Coming up next" and the full grid), but instead of its own capacity badge
  and register button, the card lists its activities inline — each with its
  own capacity badge and its own small "Register" button that takes you
  straight to the Register tab with that activity preselected. "More
  details" still opens the same modal as before, showing the parent's
  photo/description plus the same activity list. A standalone event (no
  parent, no children) looks and behaves exactly as it always has.
- **"Allow one person to register for more than one activity under this
  event"**: a checkbox on the parent event's own form. Off by default — a
  member (or a specific family member/dependent) can only be registered for
  one activity under that parent at a time, and a second attempt is rejected
  with a clear message naming which activity they're already in. Turn it on
  if the event day is fine with people doing more than one activity (like
  the "Sports Entertainment Day" example above).
- Admin bulk-invite (see "Members" below) refuses to invite people directly
  to a parent that has activities under it, for the same reason direct
  registration is blocked — invite them to the specific activity instead.

## Event date, start/end time & multi-day events

Every event (standalone, parent, or activity) can optionally have a start
time, an end time, and an end date, on top of its required start date —
shown on the Add/Edit event admin forms right next to the date field.

- **Start time / end time**: plain `HH:MM` time pickers. If only a start
  time is set, the landing page and details modal show just that (e.g.
  "Sunday, 2026-09-20 · 5:00 PM"). If both are set, the duration is computed
  and shown alongside them (e.g. "6:00 PM–9:00 PM (3h)"). Sub-activities show
  their own time compactly next to their name in the parent card's activity
  list, since the date is already shown once on the card.
- **Weekday name**: the event's date is always shown with its weekday
  ("Sunday, 2026-09-20" / "الأحد، 2026-09-20") — computed on the fly from the
  date, in whichever language the page is in, so there's no extra admin
  field for it.
- **End date (multi-day events)**: optional, for an event that runs across
  more than one calendar day (e.g. a weekend tournament). Must be on or
  after the start date. When set, the card and modal show a date range
  ("Fri, 2026-10-02 – Sat, 2026-10-03"), and the event doesn't move to
  Annual Activities (and can't be edited) until its *end* date has passed,
  not its start date. Leave it blank for the normal single-day case — this
  is fully backward compatible with every event created before this
  existed.

## Admin: Deleting events

A "Delete an event" card on Admin lets the committee remove an event
outright — unlike editing, this works for **both upcoming and already
finished** events, since cleaning up a mistaken or duplicate entry
shouldn't be blocked by the usual edit-lock. Deleting an event also removes
every registration tied to it (points, check-ins, waiting-list entries —
all of it), so the confirmation prompt spells out how many registrations
will go with it. **This can't be undone.** A parent event that still has
activities nested under it can't be deleted directly — delete or reassign
those activities first, so nothing is left pointing at a parent that no
longer exists.

## Arabic-first event names & descriptions

Wherever an event's name or description is shown, the Arabic text is
displayed first with the English text underneath (or alongside, in compact
spots like dropdowns) — this is fixed and does **not** change when a
visitor switches the site language with the EN/AR toggle. It only affects
which language leads; it doesn't hide either language, and an event with
only one language filled in just shows that one on its own.

This applies on the events grid cards, the event details modal (title,
"About" text, and past-event recap), and every place an event name appears
in a dropdown or admin table. The **admin "Add an event" and "Edit an
event" forms** also list the Arabic Name and Arabic Description fields
before their English counterparts, matching the display order.

## Admin: sub-tabs & icons

The Admin section is organized into six sub-tabs so committee members
aren't scrolling through one long page of ~19 cards to find a specific
tool: **Overview** (the stats strip + Event dashboard), **Events** (Add,
Edit, Delete, and Enter results), **Members** (import/export/invite,
Member directory, Reset a member's password), **Points & Rewards**
(points visibility, redemption requests, points rules, redemption
ladder), **Content & Chat** (support chat, post news, community
spotlights), and **Settings** (branding, staff & admin accounts, change
my password). The sub-tab bar sticks to the top of the screen while
scrolling through a tab's cards, and the last tab an admin had open is
remembered per-browser (via `sessionStorage`) so it's still there after
navigating away and back. The **Points & Rewards** and **Content & Chat**
tabs also carry a small badge — mirroring the pending-redemptions count
and the unread-support-chat count — so it's obvious at a glance when
something in that group needs attention, without opening it. Every card
also got a small icon next to its title purely for faster visual
scanning; this and the sub-tabs are cosmetic/organizational only — no
admin functionality, field, or endpoint changed.

## Admin: Event dashboard

A new card on the Admin tab, "Event dashboard," lists every event
(newest first) with its registration count vs. maximum capacity, the
minimum target if one is set, how many are on the waiting list (click the
count to see who, and promote from there), how many have actually checked
in, and an attendance rate (checked-in ÷ registered). It's meant as the
one place to see "is this event filling up, and did the people who signed
up actually show up" without cross-referencing the registrations list by
hand.

## Admin: Members — import, export & inviting to an event

A "Members" card on the Admin tab, right below the Event dashboard, lets
the committee manage the member roster in bulk instead of one member at a
time:

- **Export members (.xlsx)** downloads the full roster (membership
  number, name, phone, family group) as an Excel file — useful as a
  backup, or as a starting point for a file you'll edit and re-import.
- **Import members (.xlsx)** reads an Excel file with those same four
  columns (column order doesn't matter, and header matching is
  case-insensitive; Phone and Family Group are optional). A membership
  number that already exists gets its name/phone/family group updated in
  place — it never touches that member's password or family members. A
  brand-new membership number gets a fresh profile with no password set
  yet.
- A member imported this way **doesn't have a password yet**, so they
  can't log in immediately. They (or the committee, on their behalf)
  "claim" the profile later by using the normal Register/Sign-up screen
  with that same membership number — it recognizes the existing profile
  and just adds a password to it, keeping whatever phone/family group was
  already on file unless they type something different.
- **Invite members to an event** bulk-registers selected members for a
  chosen event directly — a confirmed spot and a QR code, no self-service
  registration required from them. This is meant for "we already know
  who's coming, let's just add them" rather than everyday sign-ups.
  Search narrows the list by name, membership number, or phone; tick the
  ones to invite, then click "Invite selected members." Anyone already
  registered (or already on the waiting list) for that event is silently
  skipped rather than duplicated. Like promoting from the waiting list,
  inviting deliberately does not enforce the event's maximum capacity —
  it's a manual admin action, so the system trusts the judgment call
  and just reports afterward if the event is now over its set limit.

## Support chat (member ↔ committee)

Member Profile has a "Message the committee" card — a private message
thread between that member and the committee as a whole (any admin can see
and reply to it, not just one specific person). It's for quick questions
("can I still register?", "my QR isn't scanning") without needing a phone
number or email on hand.

On the Admin tab, "Member support chat" is the other side of this: an
inbox listing every member who has an open conversation, each with an
unread-count badge, sorted by most recent message. Click a conversation to
read and reply. Both the Member Profile and Admin tabs also show a small
red badge on their own tab button whenever there's something unread, so
it's noticeable without needing to go looking for it.

There's no email or push notification behind this — it's all in-app.
While a conversation is actually open on screen it polls every 5 seconds
so a back-and-forth feels close to real time; the unread badges refresh
every 20 seconds everywhere else in the app, same rhythm as the Events
landing page's auto-refresh. Only admins can access the support inbox
(not the Staff role, which stays scoped to the Gate Scanner) — if the
committee wants more people answering messages, add them as admin
accounts from "Staff & admin accounts."

## Events landing page & Annual Activities

The **Events** tab is the landing page — a grid of cards for every upcoming
event, each with a cover photo, name, date, sport, and two buttons:
**More details** (a pop-up with the full description and photo) and
**Register** (jumps to the Register tab, signs the member in if needed, and
pre-selects that event so they just confirm).

When an admin adds an event from the Admin tab, they can now attach a cover
photo and a description (EN/AR) alongside the existing name/date/sport
fields.

**Editing an event.** A separate "Edit an event" panel on the Admin tab lets
an admin pick any upcoming event, change any of its details (name, sport,
date, early-registration deadline, description, or replace the cover photo),
and save. Editing stays open **up until the event's date passes** — once an
event finishes and moves to Annual Activities, its details lock and only
the after-event recap can still be added (same as before). This keeps
event details correctable (fixing a typo, updating a date, swapping a
photo) without having to delete and recreate the event.

**The landing page updates itself.** The Events and Annual Activities tabs
re-fetch the event list every time they're opened, and also refresh
automatically every 20 seconds while either one is on screen. So an edit an
admin makes — on the same device or a different one — shows up for anyone
already looking at the landing page without them needing to reload the
browser.

**A friendlier landing page.** The Events tab now opens with a welcome
banner, then five sections: **Coming up next** (the 2-3 soonest upcoming
events, called out with a gold "coming up next" tag so they stand out),
**All upcoming events** (the full grid, same as before), **Committee News**
(short announcements the admin posts — see below), **Community** (a quick
stats strip — total members and events held — plus a top-5 point-earners
leaderboard), and **Community Spotlight** (member highlights — see below).
"Coming up next" is just a featured view of the same events in the full
grid below it, not separate data — nothing to keep in sync. The stats and
leaderboard are computed live from the same data everywhere else in the
app uses (member count, past events, and each member's point balance), so
there's nothing to keep updated by hand either.

**Committee news and community spotlights.** Two new panels on the Admin
tab: "Post committee news" (a title, body text, and optional photo, in
EN/AR) and "Community spotlights" (a member's name, a short note about
them, and an optional photo). Both show up on the Events landing page
immediately, newest first, and can be removed from the same admin panel
they were added from. There's no member-facing input here — spotlights are
curated by the committee, not self-nominated. The Community stats/leaderboard
section next to it needs no admin input at all — it's derived automatically,
so both sections can be used together or you can just ignore whichever one
your committee doesn't need.

**Events move themselves.** There's no "archive" button — an event is
"upcoming" or "past" purely based on comparing its date to today, checked
fresh every time the page loads. The moment an event's date is in the past,
it disappears from the Events tab and appears on **Annual Activities**
instead, automatically.

**Recap content** (a short write-up of how the event went, plus extra
photos) is added from the same "Enter event results" admin panel used for
finishing positions — a recap section appears right below it. It's
optional and can be filled in any time after the event, with or without
registrations on file for it. Once saved, that write-up and photo gallery
are what show up when someone opens "More details" on that event's card in
Annual Activities.

Photos are stored as plain files under `public/uploads/events/` (created
automatically), not inside `data/db.json` — keeps the JSON store small.
Back up that `uploads` folder alongside `db.json` if you want event photos
included in your backups.

## Admin: Branding (colors & logo)

A "Branding" card near the top of the Admin tab lets the committee set a
primary color, an accent color, and a logo. All three apply everywhere
at once — the header, hero banner, buttons, badges, tab underline, the
Redemption Ladder — because the whole app is already built on three CSS
custom properties (`--red`, `--red-dark`, `--gold`); changing them at
runtime re-themes every page, including the public landing page, without
touching any file. The darker shade used for gradients/hover states is
computed automatically from the primary color, so there's only ever two
colors to pick. "Reset to defaults" puts it back to the original
maroon-and-gold and removes the logo. Since the landing page needs the
right colors and logo before anyone logs in, this is read from the
already-public `/api/settings` endpoint (same one the points-visibility
toggle uses) — no auth required to read it, only to change it.

## Editing the points system

Admins can change the point values and the redemption ladder directly from
the **Admin** tab — no file editing needed:

- **Points rules**: participation points, the early-registration bonus, and
  the bonus for each of the top 6 finishing positions.
- **Redemption ladder**: for each of the 7 tiers, the points required, the
  reward text (EN/AR), the description (EN/AR), and who approves it (EN/AR).

**Important — changes are retroactive.** Points are calculated live every
time a balance is shown, not frozen the moment a member earns them. So
changing, say, the participation points from 100 to 150 immediately raises
the value of every past registration too, not just future ones. The admin
UI shows a warning before saving for exactly this reason — make changes
deliberately, ideally between events rather than mid-event.

**Showing or hiding the points system entirely.** A "Points system
visibility" card on the Admin tab has a single switch: "Show points &
Redemption Ladder to members." Turn it off and, for members, the points
balance on Member Profile, the "(+N points)" note on registration
confirmations, and the whole Redemption Ladder tab all disappear — replaced
with a plain "not active right now" note where relevant. Nothing is
actually paused: points keep accumulating in the background exactly as
before (check-ins still award them, the admin overview still shows real
totals), so turning it back on later picks up right where things left off.
This is meant for committees who want to launch registration/attendance
first and switch points on once they're ready, without losing any history
in between.

## How the data works

All data lives in `data/db.json` — a single file, so there's nothing to
install or configure. It's meant as a working prototype (matches the
document's Phase One spirit: "nothing technically complex"). If member and
event volume outgrows a single JSON file (Phase Three in the document), the
`readDb()`/`writeDb()` functions in `server.js` are the only place that
needs to change to move to a real database — the API and frontend stay the same.

**Back it up regularly** — copy `data/db.json` somewhere safe (or put the
whole project under git) since it's the only copy of your registrations and
points.

## Family pooling (Phase Two, built in from day one)

Every member has a `familyGroup` field. Leave it empty and that member is
tracked individually. Fill it in (same value for everyone in the family) and
their points automatically pool together — no code change, no migration.
This mirrors the source document's specific design intent: the slot is
reserved from day one so Phase Two never becomes a "complex data-migration
project."

## Matching the spreadsheet toolkit

This app and the `Ahlawy_Points_System_Toolkit.xlsx` workbook (delivered
alongside it) use identical point-calculation logic, so the committee can
run either one — or start with the spreadsheet on day one and move to this
app later — without the numbers ever disagreeing.

## Project layout

```
server.js               Express backend + all API logic (points, ladder, redemptions, check-in)
data/db.json             All persisted data (events, members, registrations, redemptions)
public/uploads/events/   Event cover photos + recap photos (created automatically)
public/index.html        Single-page bilingual frontend (EN/AR, RTL-aware)
public/i18n.js            English/Arabic text dictionary
public/app.js             Frontend logic (calls the API, renders tables, camera scanning)
public/jsQR.js            Vendored QR-decoding library (no internet needed at runtime)
public/styles.css         Styling
```

## A note on camera access

Browsers only allow camera access (`getUserMedia`) on `https://` or on
`localhost` — never on a plain `http://` address on another device. That
means the Gate Scanner tab works fine during local testing on the same
machine (`http://localhost:3000`), but once you deploy this for real
gate staff to use on their own phones, the site needs to be served over
HTTPS (a free certificate from something like Let's Encrypt, or a host
that provides HTTPS by default, works fine).

## Security hardening

A few defensive measures beyond the basics:

- **Login rate limiting**: both `/api/auth/login` (members) and
  `/api/auth/staff-login` (staff/admin) allow at most 15 *wrong-password*
  attempts per visitor IP per 10 minutes before returning `429 Too Many
  Requests`. Successful logins never count against this, so several staff
  logging in back-to-back from the same event WiFi is never a problem —
  only repeated failures are.
- **Security headers** via `helmet`, with a custom Content-Security-Policy
  that still allows what this app actually needs: inline `style="..."`
  attributes (used throughout the HTML) and `data:` image URIs (how QR
  codes render). Everything else defaults to same-origin only.
- **Session cookie** is `httpOnly`, `sameSite: "lax"`, and `secure` exactly
  when the request itself arrived over HTTPS (`req.secure`) — so it's
  HTTPS-only on the real deployment without breaking local development
  over plain `http://localhost`.
- The app trusts exactly one reverse-proxy hop (`app.set("trust proxy",
  1)`) so the rate limiter sees each visitor's real IP and `req.secure`
  correctly reflects HTTPS behind Railway's proxy. Don't raise this past
  `1` unless another proxy layer is added in front of Railway's.
- HTTPS itself doesn't need any app-level configuration — Railway
  terminates TLS automatically for the `*.up.railway.app` domain (and for
  a custom domain, if one is ever added).

## Deploying somewhere real

This runs anywhere Node.js runs (a VPS, Render, Railway, an internal server).
Point a domain at it, set the bootstrap admin env vars and `QR_SECRET`
(above), and put `data/db.json` on a volume that persists across deploys.
For real production use with many concurrent committee members editing at
once, swap the JSON-file store for a proper database (SQLite is a drop-in
next step) — see "How the data works" above.

One more thing worth knowing: login sessions are kept in memory, not saved
to disk, so restarting the server logs everyone out (they just log back in
— nothing is lost). That's a deliberate simplicity trade-off for this
prototype; a persistent session store is a small follow-up if it matters
for your deployment.
