---
url: "http://localhost:3000"
---

You are testing "Prysm Note" (an AI task manager, three-pane UI: sidebar,
timeline, AI chat). You are already signed in as "Autonoma Tester". Work through
the checks IN ORDER. You must stay signed in the whole time — do NOT log out.

CRITICAL TARGETING RULES (follow every time you click or type):
- For TYPING, click one of the actual inner text boxes, not an outer container or
  an icon. Prefer an element whose placeholder is given below. Do not click the
  placeholder label itself.
- Click buttons by their exact visible text.

CHECK 1. VERIFY WORKSPACE: A sidebar should be on the left, a timeline in the
center (with dated columns like "22" "23" "24"), and "Autonoma Tester" at the
bottom-left. If any of those are missing, stop and report FAILURE.

CHECK 2. CREATE A TASK AND SEE IT ON THE TIMELINE:
There are TWO "+ New" buttons. One is under "LISTS" in the left sidebar (that one
makes a LIST — do NOT click it). The other is in the MAIN toolbar, to the right of
the words "Timeline" and "Notes" (that one makes a TASK). Click the MAIN "+ New"
button (the one near "Notes").
A task form opens. In it, click the text box whose placeholder text is exactly
"What needs to be done?" and type: Autonoma task 123
(Do not put text in the smaller "Add details..." box.)
Now click the button whose visible text is "Create Task" (a solid purple button).
Afterwards the task form should close. Assert that the timeline now shows a bar
labeled "Autonoma task 123" and that the text "Autonoma task 123" is visible
somewhere on screen. If the form is still open OR the text is not visible
anywhere, that is a FAILURE.

CHECK 3. SEARCH WITH Control+F:
Press Control+F. A search text box with placeholder starting "Search tasks" should
appear/focus in the toolbar. Click it and type: Autonoma task 123
The list should now be filtered so only that task matches. If pressing Control+F
does nothing or typing into it has no filtering effect, that is a FAILURE.

CHECK 4. SETTINGS TOGGLE ACTUALLY HIDES UI:
Click the gear button (⚙) in the sidebar to open Settings. Find a tab labeled
"UI Modules" or "Features". Turn OFF exactly one toggle such as "Sidebar" or
"Timeline view" (click the toggle button next to it). Go back to the main
workspace. Confirm that element is now hidden. Then reopen Settings and turn it
back ON, and confirm it is visible again. If toggling produced no visible change,
that is a FAILURE.

CHECK 5. AI CHAT REPLIES:
Open the AI chat panel (the button on the far right, near ⚡). Read the provider
shown in the dropdown. In the chat text area (placeholder starts "What would you
like me to do?"), type: Reply with just the word OK
Press Enter to send. A reply should appear that is NOT an error. If the reply is
an error such as "failed to fetch" or "check your API key", that is a FAILURE.

Report each check as PASS/FAIL with a one-line reason, and to finish, list every
FAILURE explicitly.
