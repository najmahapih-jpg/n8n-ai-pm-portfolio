# Scoring Policy

Policy version: `lead-intel-v0.1.0`

## Scores

- ICP fit starts at 20 and adjusts for employee band, industry fit, geography, enterprise plan, free email domains, academic/student signals, and competitor signals.
- Intent starts at 30 and adjusts for keyword signals, lead source, requested product, and message detail.
- Priority score is `round(icpFitScore * 0.58 + intentScore * 0.42)`.
- Competitor leads are capped at 25.
- Manual grade override raises priority to at least 85 and then applies the supplied grade.

## Grades

| Grade | Rule | Default Route |
| --- | --- | --- |
| A | `priorityScore >= 80` | `enterprise-ae` |
| B | `priorityScore >= 62` | `midmarket-ae` |
| C | `priorityScore >= 40` | `sdr-qualification` |
| D | below 40 | `nurture` |

Competitor leads override normal grade routing to `disqualified-competitor`.
