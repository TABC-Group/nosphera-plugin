---
description: Claim a pull request or Linear issue on Nosphera as proof of work, before it is finished
argument-hint: "<pull request or Linear issue link>"
---

Claim the item in `$ARGUMENTS` on Nosphera so that it counts as verified proof once it is merged or closed.

1. If `$ARGUMENTS` is empty, look for the pull request opened most recently in this session (for example the URL printed by `gh pr create`). If there is none, ask the user for the link and stop.
2. The link must be a public GitHub pull request (`https://github.com/<owner>/<repo>/pull/<number>`) or a Linear issue (`https://linear.app/<workspace>/issue/<KEY-123>`). Anything else cannot be claimed; say so and stop. For a GitHub link, check the repository's visibility using GitHub metadata (for example `gh repo view <owner>/<repo> --json visibility`), without fetching private content. Proceed only if confirmed **PUBLIC**; otherwise stop without sending the link or repository name to Nosphera. Never use `claim_work` to test visibility. This check does not change the supported Linear issue flow.
3. Call the Nosphera tool `claim_work` with `link` set to that URL.
4. Report the result in one or two lines:
   - success: the claim is pending; Nosphera checks it after the merge or close, and qualifying outside confirmation earns points. An owner's-side merge or completion is an unverified claim worth zero.
   - `E_PROOF_CLAIM_EXISTS`: already claimed, nothing to do.
   - `E_TOOL_NOT_CONNECTED`: the owner must connect GitHub or Linear under Settings, Connected tools, on nosphera.com.
   - an authentication error: run `/mcp`, choose **nosphera** and **Authenticate**.

Never claim a pull request that is already merged, and never open a pull request just to claim it.
