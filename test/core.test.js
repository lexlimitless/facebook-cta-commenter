import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCommentsFile, parseDate, normalizeTitle, findEntry, decide, isOurComment,
  COMMENT_DELAY_MS, MAX_LATE_MS,
} from '../src/core.js'

const SEP = '='.repeat(76)
const PAGE = '909100045852088'

const sample = `HEADER
${SEP}
VIDEO 019 | Tuesday, October 13, 2026
CHOSEN TITLE: Your Podcast Isn’t Making Money? This Could Be Why

PINNED COMMENT:
Have any clients told you?

See how it works: https://pepper.ly/e454c77

${SEP}
VIDEO 008 | Tuesday, October 20, 2026
CHOSEN TITLE: How I Turned a Podcast Into a Clip With 430,000 Views

PINNED COMMENT:
Second comment https://pepper.ly/29953f5
`

describe('parseCommentsFile', () => {
  it('reads every block with its date, title and full comment', () => {
    const { entries, errors } = parseCommentsFile(sample)
    assert.deepEqual(errors, [])
    assert.deepEqual(entries, [
      { video: '019', date: '2026-10-13', title: 'Your Podcast Isn’t Making Money? This Could Be Why', comment: 'Have any clients told you?\n\nSee how it works: https://pepper.ly/e454c77' },
      { video: '008', date: '2026-10-20', title: 'How I Turned a Podcast Into a Clip With 430,000 Views', comment: 'Second comment https://pepper.ly/29953f5' },
    ])
  })

  it('parses the real file cleanly', () => {
    const { entries, errors } = parseCommentsFile(readFileSync(new URL('../facebook-pinned-comments.txt', import.meta.url), 'utf8'))
    assert.deepEqual(errors, [])
    assert.equal(entries.length, 21)
    for (const e of entries) assert.match(e.comment, /https:\/\/pepper\.ly\/\w+$/)
  })

  it('rejects placeholders, missing parts and duplicate titles', () => {
    const bad = `${SEP}\nVIDEO 1 | Tuesday, October 13, 2026\nCHOSEN TITLE: A\n\nPINNED COMMENT:\nGo [LINK_001]\n` +
      `${SEP}\nVIDEO 2 | Tuesday, October 13, 2026\nPINNED COMMENT:\nx\n` +
      `${SEP}\nVIDEO 3 | Tuesday, Octember 13, 2026\nCHOSEN TITLE: C\n\nPINNED COMMENT:\nx\n` +
      `${SEP}\nVIDEO 4 | Tuesday, October 13, 2026\nCHOSEN TITLE: D\n\nPINNED COMMENT:\nx\n` +
      `${SEP}\nVIDEO 5 | Tuesday, October 13, 2026\nCHOSEN TITLE: d\n\nPINNED COMMENT:\ny\n`
    const { errors } = parseCommentsFile(bad)
    assert.equal(errors.length, 4)
    assert.match(errors.join('\n'), /placeholder/)
    assert.match(errors.join('\n'), /needs VIDEO/)
    assert.match(errors.join('\n'), /Octember/)
    assert.match(errors.join('\n'), /same title/)
  })
})

describe('matching', () => {
  const { entries } = parseCommentsFile(sample)

  it('parses dates with or without a weekday', () => {
    assert.equal(parseDate('Tuesday, March 2, 2027'), '2027-03-02')
    assert.equal(parseDate('March 2, 2027'), '2027-03-02')
    assert.equal(parseDate('2/3/2027'), null)
  })

  it('treats curly and straight apostrophes, case and spacing as equal', () => {
    assert.equal(normalizeTitle('Isn’t  It'), normalizeTitle("isn't it"))
    assert.equal(findEntry(entries, "Your Podcast Isn't Making Money? This Could Be Why")?.video, '019')
  })

  it('matches when the title is the first line of a longer caption', () => {
    assert.equal(findEntry(entries, 'How I Turned a Podcast Into a Clip With 430,000 Views\n#podcast')?.video, '008')
  })

  it('does not match on different wording', () => {
    assert.equal(findEntry(entries, 'How I Turned a Podcast Into a Clip'), null)
    assert.equal(findEntry(entries, ''), null)
  })
})

describe('decide', () => {
  const { entries } = parseCommentsFile(sample)
  const published = Date.parse('2026-10-13T14:47:00Z')
  const base = { entries, postText: 'Your Podcast Isn’t Making Money? This Could Be Why', publishedMs: published, pageId: PAGE, comments: [] }
  const ours = { from: { id: PAGE }, message: 'Have any clients told you?\nSee how it works: https://pepper.ly/e454c77' }

  it('waits until two hours after publishing', () => {
    assert.equal(decide({ ...base, nowMs: published + COMMENT_DELAY_MS - 1 }).action, 'wait')
    assert.equal(decide({ ...base, nowMs: published + COMMENT_DELAY_MS }).action, 'post')
  })

  it('never posts twice once the Page comment exists', () => {
    assert.equal(decide({ ...base, comments: [ours], nowMs: published + 2 * COMMENT_DELAY_MS }).action, 'done')
  })

  it("ignores someone else's comment containing the link", () => {
    const other = { ...ours, from: { id: '123' } }
    assert.equal(isOurComment(other, PAGE, entries[0]), false)
    assert.equal(decide({ ...base, comments: [other], nowMs: published + 2 * COMMENT_DELAY_MS }).action, 'post')
  })

  it('stops trying after three days', () => {
    assert.equal(decide({ ...base, nowMs: published + MAX_LATE_MS + 1 }).action, 'too-late')
  })

  it('reports unmatched posts', () => {
    assert.equal(decide({ ...base, postText: 'Something else', nowMs: published }).action, 'unmatched')
  })
})
