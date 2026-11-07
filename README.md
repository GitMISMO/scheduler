# Scheduler

Finds a meeting time with people inside and outside MISMO. It proposes times from the team's Outlook
availability, collects who can make which time, has Claude draft the emails, and reminds the organizer
to follow up with anyone who hasn't answered.
Live at **https://resources.mismo.org/scheduler/**, behind the shared resources.mismo.org sign-in.

This repository is **public** and holds **no records**, only the pages. Requests live in the **private**
repository `GitMISMO/scheduler-data` and are read and saved through the save relay under the project key
`scheduler`. No token, key or record is ever kept here.

| File | What it is |
|---|---|
| `index.html` | The staff tool's shell: sign-in gate (`requireAccess('scheduler')`), page layout, and the three files below. |
| `scheduler.js` | The staff tool itself: Dashboard, requests, Statistics, Help, saving through the relay. |
| `scheduler.css` | Its styles (light and dark). |
| `rail.js` | The left rail, search and theme button. |
| `respond.html` | The page an outside guest opens from their email to mark which times work. No sign-in. |

Opened anywhere other than resources.mismo.org, or with `?preview=1`, both pages run as a **preview** with
sample data and save nothing.

## Where things live

| What | Where |
|---|---|
| Requests | `scheduler-data/data/requests.json`, shaped `{docs:{<id>:{…}}}`. One file. Each save sends the sha it read, and a 409 is re-applied on top. |
| The team list and Outlook availability | **Read only**, from Team HQ: `team-hq/data/people` and `team-hq/data/cal-<person>` (the files Team HQ's Power Automate flow already writes). |
| Follow-up reminders | **Written to Team HQ** as one task per request (`team-hq/data/tasks`, id `sched-<request id>`), titled "Follow up: <meeting>", owned by the organizer and due on the follow-up date. It is set to Done when everyone has answered, the meeting is booked or it is cancelled. That puts the reminder on the organizer's Team HQ board on the right day, whether or not anyone opens the Scheduler. |
| Drafting emails | The relay's Ask route (`POST /scheduler/ask`). Needs `"ask": true` on the project. Without it, the page falls back to standard wording. |
| Emailed requests (Incoming tab) | `scheduler-data/data/inbox.json`. A Power Automate flow on scheduling@mismo.org adds each new email through `POST /scheduler/inbox/add` (flow key; it can only add). Staff mark each one *started* (linked to a request) or *set aside*. |
| Automatic scheduling | The **Scheduler Robot** in `scheduler-data` (`robot/`, run by GitHub Actions) acknowledges each emailed request, books from the times the person offered when it can, otherwise sends the poll (person who asked copied), keeps the poll current, reminds, and books. Its working notes live in each request's `robot` field, which this page never overwrites except through **Take Over** / **Hand Back**. See `scheduler-data/robot/README.md`. |
| Sending email | Everything goes out from scheduling@mismo.org through the Power Automate flow "Scheduler - Send Emails", called by the robot. A poll sent by hand from this page is written to `data/outbox.json`; the robot sends it on its next run. |
| Outside guests' answers | Two no-sign-in relay routes, `POST /scheduler/poll/view` and `/poll/answer` (relay request 11). Until they're live, the page says so and staff enter answers by hand. |

A person needs **Scheduler** access (Edit or View) in People & Access. To see Outlook availability and get
the Team HQ reminders, they also need **Team HQ** access, which every staff member already has. Without it
the Scheduler still works; it just can't show availability or write the reminder.

## A guest's link

`respond.html#r=<request id>&g=<guest id>.<code>`. The code is 24 random characters made in the staff
member's browser, stored only in the private data repository. It sits after the `#`, so it is never sent
in an address a server logs or passed on as a referrer. The relay compares it in constant time and returns
only what that one guest needs. It never returns other guests, the MISMO attendees, the original email or
the log.

## Updating

Before uploading a new copy of a page, download the current one from GitHub first and make your changes to
that copy. Uploading an older copy silently undoes everything that changed since.

Storage keys are `tools:scheduler:<name>`. The page never calls `localStorage.clear()`.

When `scheduler.js`, `scheduler.css` or `rail.js` change, bump the `?v=` stamp on their tags in `index.html` and upload it too, so browsers pick up the new copy. The full developer handbook is `robot/README.md` in `GitMISMO/scheduler-data`.
