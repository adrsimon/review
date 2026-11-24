---
name: commit
description: Grade the active review-training session. Reads the comments the user left in the viewer, compares them with what the real human reviewers raised, what changed before merge, and the agent's own blind review, scores the review against a fixed rubric, updates the user's strengths-and-weaknesses log, and gives a debrief. Use when the user runs /review-training:commit or says they finished their training review.
---

# Grade a review-training session

Every helper call is `bun "${CLAUDE_PLUGIN_ROOT}/scripts/rt.ts" <command>`. Each prints JSON.

## Steps

1. **Find the session.** Run `rt.ts status`.
   - If nothing is active, say so and point to `/review-training:start`.
   - If `submitted` is false, ask once with AskUserQuestion: grade the review as it stands
     (`comments` comments so far), or go back to the viewer (print `url`, or run `rt.ts launch` if it
     is null). Respect the answer.

2. **Collect.** Run `rt.ts collect`. It returns the trainee's review (comments with their line
   ranges and excerpts, summary, verdict), which files they opened or marked viewed, and the paths
   to everything else.

3. **Make sure the blind reviews exist.** `paths.agentReviews` lists every reviewer with its `out`
   path and whether it is `ready`. For each one that isn't:
   - If its subagent from `/review-training:start` is still running in this conversation, wait
     for it.
   - Otherwise run it now. Fill `${CLAUDE_PLUGIN_ROOT}/reference/blind-review.md` the same way
     `/review-training:start` does (`{focus}` empty for `default`, the "Skill focus" paragraph for a
     skill) and launch the missing ones as general-purpose subagents, all in one message so they
     run in parallel. If `worktree` is null, tell them to work from the diff alone.
   - Never give a blind reviewer the trainee's comments.

4. **Grade.** Read `${CLAUDE_PLUGIN_ROOT}/reference/rubric.md` and follow it exactly. You need
   `reviewedDiff`, `threads`, `reviews`, `postReviewDiff`, `postReviewCommits` and every file in
   `agentReviews`.
   Check claims against the code in `worktree` while it still exists, because `record` deletes it.
   Write `<sessionDir>/score.draft.json`.
   - Be fair in both directions. The real reviewers missed things too, so a valid comment they
     never made is a `valid_new`, not noise. A comment is only `matched` if it names the same
     problem.
   - A large PR can be split: one general-purpose subagent per group of files can build candidate
     issues. You still merge them, assign severities, and do the comment matching yourself, so the
     grading stays consistent.

5. **Record.** Run `rt.ts record <id> <sessionDir>/score.draft.json`. It validates the file,
   computes `overall`, appends to the history, updates the category profile, stops the viewer and
   removes the worktree. If it rejects the file, fix the file and run it again.

6. **Update the log** at the path `record` returns in `log` (create it if missing). Keep this
   structure and keep the file under about 150 lines:

   ```markdown
   # Review training log

   ## Weaknesses
   - **<behaviour pattern>**: <n> of <m> sessions, last <yyyy-mm-dd> (<repo>#<number>). <one line of advice>

   ## Strengths
   - **<behaviour pattern>**: <n> of <m> sessions, last <yyyy-mm-dd>.

   ## Sessions
   - <yyyy-mm-dd> <repo>#<number> "<title>": <overall>/100. Caught: <short>. Missed: <short>.
   ```

   - Merge this session's `strengths` and `weaknesses` into existing patterns when they describe
     the same behaviour, and bump the counts.
   - A pattern seen in only one session stays in that session's line until it shows up again.
   - Move a weakness to Strengths once the last three sessions show it fixed.
   - `m` is the number of graded sessions so far.
   - Newest session goes first under Sessions.

7. **Debrief.** This is the first time the user sees the answer key, so make it worth reading:
   - the overall score, the one-line criterion scores, and the delta against their previous
     session if there is one;
   - the most important issues they missed (at most three, highest severity first), each with
     `path:line`, what was wrong, and what the real reviewer said or what the fix was;
   - their best catch, especially a `valid_new` one;
   - if skill reviewers ran, which of them found issues the trainee missed (from `foundBy`), in a
     line or two: that tells the user which lens they lack;
   - any comment classed `wrong`, explained briefly;
   - one concrete thing to practise next time, taken from the log's Weaknesses;
   - the PR URL, now that it is safe to open.

8. **Score card.** Run `rt.ts card <id>`. It writes a 1200x675 score card and opens it in the
   browser, with buttons to copy it or save it as PNG. Mention it in one line. If
   `namesRepository` is false, add that the card leaves the repository and PR out because the
   repository isn't public.
