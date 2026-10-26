# Facebook CTA commenter

About two hours after each video goes live on the Paul Stennett Facebook Page, this posts that video's call-to-action comment as the Page. It then opens a GitHub issue reminding you to pin it, because Meta's API can't pin comments.

## Editing the comments

Edit `facebook-pinned-comments.txt` on github.com. Each video is a block that starts with a line of `=` characters:

```
VIDEO 019 | Tuesday, October 13, 2026
CHOSEN TITLE: Your Podcast Isn’t Making Money? This Could Be Why

PINNED COMMENT:
Everything under this line is posted word for word.
```

- **CHOSEN TITLE** must match the Facebook post text exactly. Curly and straight apostrophes, capital letters and extra spaces count as the same, but any other wording difference means no comment. A scheduled video with no matching title gets an issue, so you can fix it before it goes live.
- The date is only used for the report. Posts are matched by title.
- If any block can't be read, nothing is posted, and the Test check on your commit turns red.

## When it runs

- **Every 10 minutes on Tuesdays**, 9:00 AM to 1:00 PM Jamaica time.
- **Once a day** as a backup, for anything published on another day.

It comments once 2 hours have passed since publish. If a video has been live for more than 3 days without its comment, it opens an issue instead of posting late.

## Safety

- Nothing is posted unless `config.json` has `"live": true`. Otherwise every run is a dry run, which only writes a report to the run's summary page.
- It never comments on the same post twice:
  - it checks for a Page comment with the same links before posting
  - only one run happens at a time
  - a post is never retried within a run
- The Page token can't publish posts. It only has permission to manage comments.

## Setup

Add two repository secrets under **Settings → Secrets and variables → Actions**:
- `FB_PAGE_TOKEN`: a non-expiring Page token
- `FB_PAGE_ID`: `909100045852088`

To check things by hand, go to **Actions → Comment → Run workflow** and pick `dry-run`.

## Token renewal

Meta's data access for the token expires around **Jan 6, 2027**. Three weeks before that, the runner opens an issue. To renew, re-authorize the "Claude Author Commenter" app, generate a new Page token, and update `FB_PAGE_TOKEN`.
