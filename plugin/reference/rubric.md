# Grading rubric, version 1

This is the reference `/review-training:commit` grades against. The criteria, weights and anchors
are fixed. If you change them, bump `RUBRIC_VERSION` in `scripts/rt.ts`, because stats compare
scores across sessions. The overall score is computed by `rt.ts record` from your criterion scores.
Don't compute it yourself.

## 1. Build the issue set

An issue is something wrong with the **reviewed version** that a good reviewer should raise. Draw
from three sources and merge duplicates. Every issue must point at code in `reviewed.diff`, or in the
worktree at the reviewed sha, and you must check it there.

| source | what counts |
| --- | --- |
| `thread` | A human review thread from `threads.json` that is a request or a concern, not praise or a pure question already answered in the code. Prefer threads with `addressed: true` and `onReviewedVersion: true`. A thread that was neither resolved nor outdated still counts if the code backs it up. Threads opened on a later version count only if the problem already existed in the reviewed version. |
| `post_review` | A change in `post-review.diff` that fixes a real problem in the reviewed version, even if no thread asked for it (the author spotted it, or a reviewer said it elsewhere). Ignore formatting, rebases and changes brought in by merges from the base branch (see `post-review-commits.txt`). Ignore new scope that wasn't a fix. |
| `agent` | A finding from any of the blind reviews (`agent-review.json`, plus one `agent-review.<skill>.json` per skill reviewer) that you confirm against the code. Drop the ones you can't confirm. A skill reviewer speaks for that codebase's own standards, so a confirmed finding that breaks them counts even if a generic reviewer wouldn't raise it. |

Review bodies and conversation comments in `reviews.json` can be issues too, under `thread`.

For each issue, record:

- `id`: `I1`, `I2` and so on
- `title`: one line
- `path` and `line` (head side of the reviewed version where possible)
- `severity`, one of:
  - `blocker`: would ship a bug, data loss, a security hole or an outage
  - `major`: wrong behaviour in a real case, a contract break, a missing test for risky logic, or a design problem that will cost later
  - `minor`: a real but small problem, such as unclear naming that misleads, a missing edge-case guard on an unlikely path, or duplication
  - `nit`: style or preference
- `category`, one of: `correctness`, `security`, `performance`, `concurrency`, `error_handling`, `api_contract`, `design`, `tests`, `readability`, `ops_migration`
- `sources`: a subset of `thread`, `post_review`, `agent`
- `foundBy`: for `agent` issues, the reviewers that raised it (`default` or the skill name)
- `evidence`: the quote, diff lines or reasoning that shows it is real
- `caught`: true if one of the trainee's comments raises it (see section 2)
- `matchedComments`: the ids of those comments

Grade severity on the merits, not on how loudly the original reviewer said it.

## 2. Classify each trainee comment

Classify every comment in `review.comments`, plus the summary if it raises anything, as exactly one
of these:

- `matched`: it raises an issue in the set. It has to name the same underlying problem, not just
  touch the same line. Being vague is fine if the problem is clearly identified. A question counts
  as a catch when its answer would expose the issue ("what happens if `x` is empty here?").
- `valid_new`: a real issue nobody else found. Add it to the issue set with `sources: []` and
  `caught: true`, then judge whether it deserves bonus points.
- `wrong`: a false claim, or a misreading of the code.
- `noise`: true but not worth a reviewer's comment, for example restating the code, praise with no
  information, or a nit on code the PR doesn't touch.

## 3. Score each criterion from 0 to 5

Use these anchors. Half points are allowed. Write a one-line rationale per criterion.

**finding_defects** (weight 30). Compute R, the share of issue weight the trainee caught, with
weights blocker 3, major 2, minor 1. Nits are excluded.
5: R ≥ 0.9 · 4: R ≥ 0.7 · 3: R ≥ 0.5 · 2: R ≥ 0.3 · 1: R > 0 · 0: R = 0.
If the issue set has no blocker, major or minor issues, give 5 when no comment is `wrong`,
otherwise 3.

**precision** (weight 15). Compute P = (`matched` + `valid_new`) / all classified comments.
Same thresholds as R. If the trainee wrote no comments, give 3.

**severity_calibration** (weight 10). There are no severity tags, so read it from the wording
("nit:", "blocking", "must", "consider") and from where the effort went. Did serious problems get
said firmly, and small ones lightly? Were blockers framed as blocking?
5: severity always clear and right · 3: mostly right, or neutral wording throughout ·
1: blockers raised as optional, or nits pushed hard while majors were missed.

**design** (weight 10). Did the trainee engage with structure: abstractions, boundaries, naming
that shapes understanding, duplication, API shape?
5: raised the design issues that mattered, or rightly found none and said why in the summary ·
3: touched design superficially · 0: missed a major design issue.

**edge_cases_and_tests** (weight 10). Did they ask about inputs, failure paths, boundaries,
concurrency, and whether the tests cover the risky parts?
5: found the important gaps · 3: some · 0: none, when there were important ones.

**coverage** (weight 10). Take the files that contain at least one non-nit issue. C is the share of
those the trainee opened (`files[].opened`) or commented on. Same thresholds as R. If no file has a
non-nit issue, use the share of all files they opened.

**actionability** (weight 10). Does each comment say what is wrong, why it matters and what to do?
5: nearly every comment is self-contained and suggests a fix · 3: about half ·
1: mostly bare questions or one-word remarks.

**verdict** (weight 5). Compare `review.verdict` with what the issue set warrants. Any blocker, or
two or more majors, warrants `request_changes`. Only minors and nits warrant `approve` or
`comment`.
5: right · 2: one step off (`comment` where `request_changes` was warranted) ·
0: `approve` with a blocker in the set, or no verdict at all.

**bonus** (0 to 5). +2 for each `valid_new` issue of major or blocker severity, +1 for each minor
one, capped at 5.

## 4. Write the score file

Write this JSON to `<sessionDir>/score.draft.json`, then run
`rt.ts record <id> <sessionDir>/score.draft.json`. `record` validates the file, computes the
overall score, appends to the history and updates the category profile.

```json
{
  "criteria": {
    "finding_defects": 3,
    "precision": 4,
    "severity_calibration": 3,
    "design": 2,
    "edge_cases_and_tests": 3,
    "coverage": 5,
    "actionability": 4,
    "verdict": 5
  },
  "bonus": 1,
  "metrics": { "R": 0.55, "P": 0.8, "C": 1.0 },
  "rationale": { "finding_defects": "...", "precision": "..." },
  "issues": [
    {
      "id": "I1",
      "title": "...",
      "severity": "major",
      "category": "error_handling",
      "path": "front/x.ts",
      "line": 42,
      "sources": ["thread", "post_review"],
      "evidence": "...",
      "caught": false,
      "matchedComments": []
    }
  ],
  "comments": [
    { "id": "<comment id or 'summary'>", "class": "matched", "issue": "I1", "note": "..." }
  ],
  "strengths": ["short, specific behaviours worth keeping, e.g. 'asked what happens on retry'"],
  "weaknesses": ["short, specific, recurring-able patterns, e.g. 'did not check error paths of async calls'"]
}
```

Write `strengths` and `weaknesses` as behaviour patterns you could recognise in another PR, not as
facts about this one. Write "doesn't follow promises into their rejection path", not "missed the
catch in `foo.ts`". The log merges them across sessions.
