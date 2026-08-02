---
url: "http://localhost:3000"
---

You are testing "Prysm Note" (an AI task manager, three-pane UI: sidebar,
timeline, AI chat). You are already signed in as "Autonoma Tester". Work through
the checks IN ORDER. You must stay signed in the whole time — do NOT log out.

HARD RULE — DO NOT NAVIGATE AWAY: The app is ALREADY loaded at
http://localhost:3000. Never navigate to any other URL (no vercel.app, no other
host). If you are ever not on http://localhost:3000, navigate back there before
continuing. The session cookies only work on localhost:3000.

CRITICAL TARGETING RULES (follow every time you click or type):
- For TYPING, click one of the actual inner text boxes, not an outer container or
  an icon. Prefer an element whose placeholder is given below.
- Click buttons by their exact visible text or label. Do not click icons beside a
  button unless a check says to.

MAIN TOOLBAR LAYOUT (left to right): a calendar icon, the view name, a search box
(placeholder "Search… (⌘F)"), a month label pill, a view-mode pill showing the
current view with a small chevron, a "Notes" pill, a solid purple "+ New" task
button, a "⚙" Settings icon, and a round "⚡" AI button.

CHECK 1. VERIFY WORKSPACE: A sidebar should be on the left, a dated timeline in
the center (with dated columns), and "Autonoma Tester" at the bottom-left. If any
are missing, stop and report FAILURE. PASS/FAIL.

CHECK 2. CREATE A TASK AND SEE IT ON THE TIMELINE:
The MAIN "+ New" is the solid purple task button in the top toolbar, LEFT of the
"⚙" Settings icon. There is ALSO a text-only "+ New List" under "LISTS" in the
left sidebar — do NOT click that one.
Click the MAIN purple "+ New". A form appears. In the text box whose placeholder
is exactly "What needs to be done?" type:
Autonoma task 123
(Do not type into the separate "Add details..." box.) Click the "Create Task"
button (solid purple). The form should close. Confirm the text "Autonoma task
123" is visible somewhere on the timeline/workspace. If it is not, FAIL.
PASS/FAIL.

CHECK 3. SEARCH WITH Control+F:
Press Control+F (or Cmd+F). The search box in the toolbar (placeholder
"Search… (⌘F)") should focus. Type: Autonoma task 123
Confirm the task list filters down to that task. Then clear the search box.
PASS/FAIL.

CHECK 4. SETTINGS TOGGLE ACTUALLY HIDES UI:
Click the "⚙" Settings icon in the top toolbar. A Settings page opens with a left
nav. Click the "Features" tab. Find the row labeled "Calendar View" and click its
toggle switch to turn it OFF. Go back to the main workspace. Open the view-mode
pill (top toolbar) and confirm the "Calendar" option is now GONE from the menu.
Then reopen Settings → "Features", turn "Calendar View" back ON, return, and
confirm "Calendar" is present in the view-menu again. If toggling produced no
change, FAIL. PASS/FAIL.

CHECK 5. AI CHAT REPLIES:
Click the round "⚡" AI button on the far right of the top toolbar. The AI Command
Center panel opens on the right. In the chat text area (placeholder starts "What
would you like me to do?"), type:
Reply with just the word OK
Press Enter to send. A reply should appear that is NOT an error. If the reply is
an error such as "failed to fetch" or "check your API key", that is a FAILURE.
PASS/FAIL.

Report each check as PASS/FAIL with a one-line reason, and to finish, list every
FAILURE explicitly.
