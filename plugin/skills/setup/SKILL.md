---
name: setup
description: Set up review training's extra reviewers. Picks skills (a repo's conventions skill, a security or performance review skill, anything that knows how this codebase should be reviewed) to run as additional blind reviewers in every session, for one repository or for all of them. Use when the user runs /review-training:setup, or wants review training to use their own review skill, team rules or several reviewers.
---

# Set up review-training reviewers

Every session already gets a built-in blind review. This adds up to four more, each one a skill the
user already has. They run in parallel while the user reviews, their confirmed findings join the
answer key, and the debrief says which reviewer caught what the user missed. A reviewer is just a
skill name: nothing to write, nothing to copy.

Every helper call is `bun "${CLAUDE_PLUGIN_ROOT}/scripts/rt.ts" <command>`. Each prints JSON.

`$ARGUMENTS` may name a repository (`owner/name`) and/or skills. Use them and skip the questions
they answer.

## Steps

1. **See what's set.** Run `rt.ts reviewers` (add `--repo owner/name` if one was given). It returns
   the `repo` it resolved, the `skills` that would review it today, and everything `configured`.

2. **Pick the skills.** Look at the skills available in this session and choose the ones that
   would make a good reviewer for this repository: code-review skills, the repo's own conventions
   or architecture skills, security, performance, accessibility, API or migration review. Leave out
   skills that do something else (shipping, deploying, writing docs, design generation, this
   plugin's own skills).
   - Make a recommendation, not a survey. Read the candidates' descriptions, take the two or three
     that best cover how this codebase gets reviewed, and say in one line each why.
   - Confirm with one AskUserQuestion (multiSelect), your picks first and marked recommended. Add
     a second question for scope only if it isn't obvious: **this repo** (default when in a
     repository, and the right choice for repo-specific skills) or **all repos** (for general
     skills like security review).
   - If nothing suitable is installed, say so plainly, and suggest writing a short skill with the
     team's review rules (`.claude/skills/<name>/SKILL.md` in the repo), then running setup again.

3. **Save it.** Run `rt.ts reviewers set <owner/name|all> <skill> [skill ...]`. This replaces the
   list for that scope; pass no skills to clear it. At most four per scope.

4. **Confirm** in two or three lines: which skills will review which repos from the next
   `/review-training:start`, and one caveat when it applies: a skill that lives in a repository
   (`.claude/skills/`) is only available when Claude Code runs inside that repository, so sessions
   started elsewhere, for example on a public repo, skip it.
