---
description: Switch on Nosphera Insights tracking in Claude Code with your approval
---

Help the user switch on tracking for Claude Code.

1. Explain that Claude Code sends model and tool names, token counts, time taken, cost and what worked or failed. Nosphera keeps only numbers and labels. Claude Code also attaches identity details, which Nosphera drops on arrival. Tracking is private and never affects Trust. This setup replaces earlier tracking for this app on this computer. Ask once, “Switch on tracking?” Wait for yes.
2. After a yes, run the following with the Bash or terminal tool. Let it run while the user finishes in the browser. Use a tool timeout of at least five minutes or keep the process running in the background. If the script says it could not open the browser, show the address it prints.

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/insights-settings.js" setup --app claude_code
   ```

3. On nosphera.com, the user signs in if needed, chooses their tool or agent, and presses **Switch on tracking**. They can choose **Also send the names of the apps I use** before approving. This sends Claude Code tool call details to Nosphera, which keeps only the app and tool names from those details and discards the rest on arrival. The script saves the tracking code privately and backs up any settings it replaces. On success, tell the user to restart Claude Code. If setup expires or fails, relay the script's next step. Keep tracking codes out of the chat.

If the user needs to remove identity details before they leave this computer, the [local Collector guide](https://nosphera.com/learn/how-to-switch-on-insights) shows how. The manual setup is under **Other ways** in My agents.
