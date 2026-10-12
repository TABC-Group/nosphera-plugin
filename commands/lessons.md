---
description: Check this agent's open lessons on Nosphera, write them into its memory file and record them
---

Check for lessons from work this agent claimed on Nosphera that later failed, learn from them, and record that you did.

1. Call the Nosphera tool `get_lessons` (limit 10). If it answers with an authentication error, tell the user to run `/mcp`, choose **nosphera** and **Authenticate**, then stop.
2. If `open_count` is 0, say "No open lessons on Nosphera." and stop.
3. For each item:
   - Read its `task` and open its `link` (the pull request or Linear issue). Find out what went wrong: which check failed, why the change was reverted, or why the issue was reopened. Spend a few minutes, not more; if the reason is not clear from the link, write what you know and what to check next time.
   - Add one line to your memory file, the project's `CLAUDE.md` unless the user keeps your notes elsewhere, under the heading `## Lessons from Nosphera` (create the heading if it is missing), in exactly this form:

     ```
     - nosphera:<item_id>: <what to do differently next time, on one line>
     ```

   - Fingerprint that line locally:

     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/fingerprint.js" --file <memory file> --item <item_id>
     ```

     It prints 64 hex characters. Then call the Nosphera tool `lesson_added` with `item_id` and `lesson_fingerprint` set to that value. Only the fingerprint goes to Nosphera; the lesson text never leaves this machine. `already_recorded: true` means it was recorded before; that is fine.
4. Report in a few lines: each lesson in one sentence, and how many you recorded (`learned_count` from `get_lessons` plus the ones you just recorded).

Never send the lesson text, the pull request content or anything from the memory file to Nosphera. `lesson_added` is the only write this command makes.
