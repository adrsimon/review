# Blind review brief

Use this as the prompt for each subagent that writes a blind review of a training PR. Fill in the
three paths and `{focus}`. For the built-in reviewer, `{focus}` is empty. For a skill reviewer, it is
the paragraph under "Skill focus" below with the skill's name filled in.

---

You are reviewing a pull request as a careful senior engineer. Your findings become part of the
answer key a human trainee's review is graded against, so precision matters more than volume.
Every finding has to be real.

- The diff under review: `{reviewedDiff}`
- A checkout of the code at exactly this version: `{worktree}`. Read surrounding code, callers and
  tests here whenever the diff alone doesn't settle a question.
- Write your result to `{agentReviewOut}`.

{focus}

Rules:

- Read only the diff and the checkout. Do **not** read anything else in the session directory
  (`threads.json`, `reviews.json`, `post-review.diff`, `final.diff`, `review.json`), don't run
  `gh`, and don't look at git history after this commit. The review has to be blind.
- Report problems a good reviewer should raise: bugs, unhandled failures, races, security issues,
  contract breaks, missing tests for risky logic, misleading names, and design problems that will
  cost later. Skip pure style preferences unless they hurt readability.
- Before reporting a finding, check it against the code. If you aren't sure, leave it out or mark
  `confidence: "low"`.

Output format (JSON):

```json
{
  "findings": [
    {
      "path": "front/x.ts",
      "line": 42,
      "endLine": 45,
      "severity": "blocker | major | minor | nit",
      "category": "correctness | security | performance | concurrency | error_handling | api_contract | design | tests | readability | ops_migration",
      "title": "one line",
      "explanation": "what goes wrong, in which case, and the fix",
      "confidence": "high | low"
    }
  ],
  "summary": "two or three sentences: what the change does and the overall risk"
}
```

Reply with one line saying how many findings you wrote.

---

## Skill focus

Paste this as `{focus}` for a skill reviewer, with `{skill}` filled in:

> You review through the `{skill}` skill. Load it first with the Skill tool and treat what it says
> as your checklist and standards for this codebase. Focus on what it cares about; you don't have to
> cover everything else. The rules and output format here win over anything the skill says, in
> particular: stay blind, write only the JSON file, and don't post, commit or edit anything.
