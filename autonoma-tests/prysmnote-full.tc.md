---
url: "http://localhost:3000"
---

You are performing a FULL end-to-end health check of "Prysm Note", an AI task
manager (three-pane UI: sidebar left, timeline center, AI chat right). You are
already signed in as "Autonoma Tester". Stay signed in the whole time — never log
out. Check each item below. For everything, click/type using the exact visible
text and placeholder given.

TARGETING RULES:
- Type only into the actual inner text box (by its placeholder), never the
  placeholder label, border, or an icon.
- Describe buttons by their exact visible text.
- There are TWO "+ New" buttons: the one under LISTS in the left sidebar makes a
  LIST (never click it); the one in the MAIN toolbar next to "Timeline"/"Notes"
  makes a TASK.

FULL CHECK LIST:

1. WORKSPACE: Confirm a left sidebar exists, a dated timeline is centered, and
   "Autonoma Tester" is visible bottom-left. PASS/FAIL.

2. TASK CREATE + VIEW: Click the MAIN "+ New" (near "Notes"). In the field with
   placeholder "What needs to be done?" type: Full check task 1
   Click "Create Task". Confirm the task appears somewhere on the timeline.

3. VIEW MODES: In the main toolbar, open the view dropdown (currently says
   "Timeline"). Confirm options "Timeline", "Kanban", "Calendar", and "List"
   exist. Switch to "Kanban" — confirm a board layout appears. Switch to
   "Calendar" — confirm a calendar appears. Switch to "List" — confirm the task
   "Full check task 1" is listed. Switch back to "Timeline".

4. EDIT TASK: Open "Full check task 1" (click it). Set its due date to today.
   Save. Confirm it is still present on the timeline.

5. SEARCH Control+F: Press Control+F. Type "Full check task 1" into the search box
   (placeholder starts "Search tasks"). Confirm the list filters to that task.

6. PROJECTS + TAGS: In the sidebar, "PROJECTS" section exists. Create a tag: click
   "+ Add" under TAGS, name it "test-tag". Confirm the tag appears in the tag
   list. (Creating via the sidebar is fine.)

7. SETTINGS UI MODULES: Open Settings (gear ⚙ ). In "UI Modules"/"Features", turn
   OFF "Sidebar", return to the main view, confirm the sidebar is hidden, then
   turn it back ON and confirm it returns.

8. THEME SWITCH: At the sidebar bottom, switch the theme (click a different color
   dot, e.g. the one next to "Lavender Light", to a different theme). Confirm the
   accent color changes. Then switch it back.

9. STICKY NOTES: Click "Notes" in the toolbar. Confirm a sticky-note board opens and
   you can add a new sticky note. Close it.

10. AI CHAT: Open the AI panel (⚡ ). Note the provider in the dropdown. In the chat
    text area (placeholder starts "What would you like me to do?") type:
    Reply with just the word OK
    Press Enter. Confirm a non-error reply comes back (if it says "failed to
    fetch" or "check your API key", that is a FAILURE).

Report every numbered item as PASS/FAIL with a one-line reason, then give a final
FAILURE LIST of only the items that failed.
