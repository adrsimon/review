---
name: start
description: Start a review-training session, in the current repo or any public GitHub repo (`/review-training:start vercel/next.js`). Picks a pull request merged in the last 24 to 72 hours that drew real review feedback, checks out the version its first human reviewer saw, and opens it in the diff viewer so the user can review it blind. Use when the user runs /review-training:start or asks to practise code review.
---

# Start a review-training session

The user is about to review a real pull request without knowing what its reviewers said. Keep it
that way. Your job here is logistics: pick the PR, set up the checkout, open the viewer, and quietly
start your own blind review in the background.

Every helper call is `bun "${CLAUDE_PLUGIN_ROOT}/scripts/rt.ts" <command>`, run from the user's
current directory. Each prints JSON.

## Arguments

`$ARGUMENTS` may hold a repository, a PR number, or both, in any order:

- `owner/name` or a `github.com/owner/name` URL: train on that repository. Pass `--repo owner/name`
  to `doctor`, `candidates` and `prepare`. It is cloned once under `~/.review-training/repos`; the
  first clone of a large repository can take a minute, so say so before `prepare`.
- a number, or a `github.com/owner/name/pull/123` URL: that pull request.
- nothing: the repository the user is in.

## No spoilers

- Never read or print anything under the session's `ground-truth/` directory, and never mention
  what reviewers said or what changed after the review.
- Don't open the PR URL, and don't run `gh pr view` or `gh api` on the PR yourself. The helper
  fetches everything you need.
- Only the PR number, title, size and file count may be shown before grading.

## Steps

0. **Preflight.** Run `rt.ts doctor` (with `--repo` if one was given). If `ok` is false, show each
   line of `problems` as is, and stop. Exception: if the only problem is `repository` and no repo
   was given, go to step 2 and offer public repositories instead.

1. **Check for an open session.** Run `rt.ts status`.
   - If `active` is set, don't start another one. Tell the user which PR is in progress, how many
     comments they have, and whether it's submitted. Offer three ways forward: reopen it with
     `rt.ts launch` (print the URL), grade it with `/review-training:commit`, or drop it with
     `rt.ts abandon`. An abandoned PR is never offered again. Stop there.

2. **Pick a pull request.**
   - If the user gave a PR number, skip to step 3 with it.
   - Otherwise run `rt.ts candidates` (plus `--repo`). If `candidates` is empty, retry once with
     `--max-hours 168` and tell the user you widened the window to a week.
   - If that's empty too, or there is no repository to work from, report the `skipped` counts
     briefly, then offer to train on a public repository instead. Ask with AskUserQuestion and offer
     these, putting first the one closest to the language of the user's repository:
     - `vercel/next.js` (TypeScript)
     - `astral-sh/uv` (Rust)
     - `django/django` (Python)
     - `rails/rails` (Ruby)
     Then run `candidates --repo <choice> --max-hours 168`.
   - Show the candidates as a short list: `#number title`, then `size` lines over `files` files,
     and "targets one of your weak spots" when `targetsWeakness` is true. Ask the user to choose
     with AskUserQuestion. Put the highest score first and mark it recommended.

3. **Prepare it.** Run `rt.ts prepare <number>` (plus `--repo`). This fetches the commits, writes the answer key,
   creates a detached worktree at the first reviewed version, links `node_modules` from the main
   checkout so types resolve, and starts the viewer in training mode. It opens the browser itself.
   - If the viewer fails to start, the error includes its log. Show the last lines. The plugin ships
     its own viewer build, so a missing viewer means a broken install: suggest reinstalling the
     plugin, or setting `REVIEW_BIN` to the viewer's `cli.js`. Then run `rt.ts launch`.

4. **Start the blind reviews.** `prepare` returns `reviewers`: the built-in one (`default`) and one
   per skill set up with `/review-training:setup`. Read
   `${CLAUDE_PLUGIN_ROOT}/reference/blind-review.md` and launch one background general-purpose
   subagent per reviewer, all in a single message so they run in parallel. For each, fill in
   `{reviewedDiff}` and `{worktree}` from prepare, `{agentReviewOut}` with the reviewer's `out`,
   and `{focus}`: empty for `default`, the "Skill focus" paragraph with its `skill` otherwise.
   Don't wait for them, and never read their output during this command. If a skill reviewer's
   skill isn't available in this session, skip it and say so in one line.

5. **Hand over to the user.** Keep it short:
   - the URL, PR number and title, and size (`files`, `+additions`, `-deletions`);
   - how to comment in the viewer:
     - hover a line number and click **+** to comment on that line;
     - press **+** and drag across lines to comment on a range (shift-click a second **+** also works);
     - use the speech-bubble button in a file header for a comment on the whole file;
     - press **R** (or the **Review** button) for the summary, the verdict and **Finish review**;
   - take your time and review it as you would at work: the clock starts now, and time spent is
     recorded but not scored;
   - if skill reviewers are running, name them in one line (for example "graded with
     `security-review` and `dust-conventions` as extra reviewers");
   - when done, run `/review-training:commit`. Closing the tab is fine, because comments are saved
     as they're written and `rt.ts launch` reopens the page.
