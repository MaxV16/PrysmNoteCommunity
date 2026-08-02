---
url: "http://localhost:3000"
---

You are performing a FULL end-to-end health check of "Prysm Note", an AI task
manager (three-pane UI: sidebar left, timeline center, AI chat right). You are
already signed in as "Autonoma Tester". Stay signed in the whole time — never log
out. Work through checks IN ORDER. Each check is independent: report PASS or FAIL
for it, then move on.

HARD RULE — DO NOT NAVIGATE AWAY: The app is ALREADY loaded at
http://localhost:3000. Never navigate to any other URL (no vercel.app, no
github.com, no other host). If you are ever not on http://localhost:3000, first
navigate back there before continuing. The session cookies only work on
localhost:3000.

TARGETING RULES (follow for every click/type):
- Click buttons by their exact visible text or label. Do NOT click icons next to
  buttons unless a check says to click that icon.
- Type only into the real text box matching the given placeholder, never the
  placeholder text, a border, or a surrounding div.
- If a dropdown you just opened appears to have closed, re-open it with one more
  click on the same toggle before asserting.

MAIN TOOLBAR LAYOUT (left to right): a calendar icon, the view name (Timeline),
a search box (placeholder "Search… (⌘F)"), a month label pill (e.g. "August
2026"), a view-mode pill that shows the current view name with a small chevron,
a "Notes" pill button, a solid purple "+ New" task button, a "⚙ Settings" icon,
and a round "⚡ AI" button.

FULL CHECK LIST:

1. WORKSPACE: Confirm a left sidebar exists, a dated timeline is centered, and
   "Autonoma Tester" is visible bottom-left of the sidebar. PASS/FAIL.

2. TASK CREATE + VIEW:
   The MAIN "+ New" task button is the solid purple button in the top toolbar,
   located to the LEFT of the "⚙" Settings icon and to the RIGHT of the "Notes"
   button. There is ALSO a "+ New List" text-only button under "LISTS" in the
   left sidebar — do NOT click that one.
   Click the MAIN purple "+ New". A form appears. In the text box whose
   placeholder is exactly "What needs to be done?" type:
   Full check task 1
   Do not type into the separate "Add details..." box. Click the "Create Task"
   button (solid purple). After it completes, the form should close. Confirm that
   the text "Full check task 1" is visible somewhere on the timeline/workspace.
   If the form stays open or the text is nowhere visible, FAIL.
   PASS/FAIL.

3. VIEW MODES:
   In the main toolbar, find the pill that shows the current view name (it says
   "Timeline") and has a small downward chevron. Click it ONCE to open the menu.
   The menu drops near the top-right and lists: "Timeline", "Kanban", "Calendar",
   "List" (one per row, left-aligned). Confirm all four options are present.
   THEN:
   - Click "Kanban" in the menu. Confirm a kanban board appears.
   - Reopen the view pill (now it will show "Kanban"); click "Calendar". Confirm
     a calendar grid appears.
   - Reopen it; click "List". Confirm the task "Full check task 1" is listed.
   - Reopen it; click "Timeline" to switch back.
   PASS/FAIL.

4. EDIT TASK:
   Click the task "Full check task 1" on the timeline. A right-side detail panel
   opens showing the task title, a Description, and controls at the bottom
   including a status pill (e.g. "todo"/"backlog"), an "Edit task" option, and a
   priority dot. You do NOT need to change anything. Confirm the panel shows the
   task title "Full check task 1" and that the task is still present on the
   timeline behind the panel. Close the panel (✕). 
   PASS/FAIL.

5. SEARCH Control+F:
   Press Control+F (or Cmd+F). The search box at the left of the toolbar
   (placeholder "Search… (⌘F)") should focus. Type: Full check task 1
   Confirm the timeline/list filters so "Full check task 1" is shown. Then clear
   the search box so it no longer filters. PASS/FAIL.

6. PROJECTS + TAGS:
   Confirm the "LISTS" section exists in the sidebar. Under "TAGS" in the sidebar
   there is a "+ Add" button. Click "+ Add", type the tag name into the input
   (placeholder "Tag name"), and confirm a new tag appears in the tag list.
   PASS/FAIL.

7. SETTINGS UI MODULES:
   Click the "⚙" Settings icon in the top toolbar. A Settings page opens. In the
   left nav of Settings, find and click the "Features" tab. Find the row labeled
   "Calendar View" and click its toggle switch to turn it OFF. Go back to the
   main workspace (click browser back or navigate to the app root). Open the
   view-mode pill (top toolbar) and confirm the "Calendar" option is now GONE.
   Reopen Settings → "Features", turn "Calendar View" back ON, return, and
   confirm "Calendar" is present again in the view menu.
   PASS/FAIL.

8. THEME SWITCH:
   At the bottom of the left sidebar there is a theme label (e.g. "Deep Space")
   with a row of small color dots. Click a DIFFERENT color dot (not the currently
   highlighted one). Confirm the accent color of the UI changes. Then click back
   the original dot to restore it.
   PASS/FAIL.

9. STICKY NOTES:
   Click the "Notes" pill button in the top toolbar. Confirm a sticky-note board
   opens and you can add a new sticky note. Then close it.
   PASS/FAIL.

10. AI CHAT:
    Click the round "⚡" AI button on the far right of the top toolbar. The AI
    Command Center panel opens on the right. In the chat text area (placeholder
    starts "What would you like me to do?"), type:
    Reply with just the word OK
    Press Enter to send. Confirm a reply comes back that is NOT an error. If the
    reply is an error such as "failed to fetch" or "check your API key", FAIL.
    PASS/FAIL.

At the end, give a final FAILURE LIST of only the numbered items that failed.
