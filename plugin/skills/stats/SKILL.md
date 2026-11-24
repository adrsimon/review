---
name: stats
description: Show how the user's code reviews have scored over time in review training. Covers session count, overall score trend, each rubric criterion over the last five sessions against the five before, recall by severity, repos trained on, and recurring strengths and weaknesses. Use when the user runs /review-training:stats or asks how their review training is going.
---

# Review-training stats

1. Run `bun "${CLAUDE_PLUGIN_ROOT}/scripts/rt.ts" stats --json`. Add `--repo owner/name` if the
   user asks about one repository.
2. If `sessions` is 0, say there are no graded sessions yet, point to `/review-training:start`, and
   stop.
3. Report the following, concisely:
   - sessions graded and abandoned, and total time spent reviewing;
   - overall score for the last 5, the previous 5 and all time, and whether it is going up;
   - a table of the eight criteria with weight, last 5, previous 5 and all time. Call out the
     biggest gain and the biggest drop;
   - recall by severity (`caught/total` for blocker, major, minor, nit);
   - the categories in `weakCategories`. These are the categories issues were missed in more often
     than caught;
   - the repos trained on.
4. If `log` is set, read it and quote the current Weaknesses and Strengths entries as they are.
   Don't rewrite them.
5. If a chart tool is available and there are at least 3 sessions, chart `overall.series` as a line
   over time.
6. If the scores show no trend yet (fewer than 5 sessions), say so rather than reading too much into
   them.
