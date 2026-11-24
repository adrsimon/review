# review-training

Practise code review on real pull requests, and get graded against what the real reviewers caught.

Reading other people's code is a skill, and most of us only practise it on whatever lands in our
queue, with no feedback on what we missed. review-training turns real merged PRs into exercises.
It picks one merged a day or two ago, checks out the exact version its first reviewer saw, and
opens it with every comment hidden. You review it blind. Then you see the answer key: the threads
the real reviewers opened, the fixes pushed before merge, and anything a blind agent review found
that the humans missed.

Over a few sessions it learns where your blind spots are ("doesn't check the empty case: 4 of 6
sessions") and starts picking PRs that test them.

## Install

A Claude Code plugin:

```
/plugin marketplace add adrsimon/review
/plugin install review-training@adrsimon
```

Needs [Bun](https://bun.sh) 1.2+, `git`, and the [GitHub CLI](https://cli.github.com) logged in.

## Use

```
/review-training:start                  # a PR from the repo you're in
/review-training:start vercel/next.js   # a PR from any public repo
/review-training:start 71234            # that exact PR
```

The PR opens in your browser in a GitHub-style diff view. Click **+** on a line to comment, drag
it to cover a range, press `R` for your summary and verdict, then **Finish review**.

| command | |
| --- | --- |
| `/review-training:commit` | grade your review, update your log, make a score card |
| `/review-training:stats` | your score trend, each criterion over time, recurring weak spots |
| `/review-training:setup` | add your own skills as extra blind reviewers |

## How you're graded

Your comments are matched against the answer key issue by issue, and scored on eight criteria:
finding defects, precision, severity, design, edge cases, coverage, actionability and verdict.
The weights are fixed and the total is computed by a script, so a 70 today means the same as a 70
next month. A valid issue nobody else raised earns bonus points: being right where the real
reviewers weren't counts in your favour. The full rubric is in
[`plugin/reference/rubric.md`](plugin/reference/rubric.md).

## Bring your own reviewers

`/review-training:setup` adds up to four of your skills as extra blind reviewers, for one repo or
all of them: your team's conventions skill, a security review, whatever knows how your codebase
should be reviewed. They run in parallel while you review, and the debrief tells you which one
caught what you missed.

## The viewer

The diff view ships as `review`, and it works on its own for any local change, including code an
agent is writing under you. It follows the worktree live, remembers which files you've cleared
until they change, captions each hunk with the agent step that wrote it, and answers hover and
go-to-definition through the repo's own language servers.

```
review              # working tree vs HEAD
review main         # HEAD vs merge-base with main
review --help
```

Install it with `bun install && bun run build && bun link`.

## License

MIT
