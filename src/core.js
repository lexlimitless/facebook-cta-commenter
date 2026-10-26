// Pure logic for the Facebook CTA commenter: parsing the comments file,
// matching Facebook posts to entries, and deciding when a comment is due.
// No network access here, so all of it is unit-tested (test/core.test.js).

export const COMMENT_DELAY_MS = 2 * 60 * 60 * 1000
// A post found later than this after going live is reported, not commented
// on: a CTA appearing days late looks odd and usually means something broke.
export const MAX_LATE_MS = 3 * 24 * 60 * 60 * 1000
export const DISPLAY_TZ = 'America/Jamaica'

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december']

// "Tuesday, October 13, 2026" -> "2026-10-13"
export function parseDate(text) {
  const m = text.trim().match(/^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/)
  if (!m) return null
  const month = MONTHS.indexOf(m[1].toLowerCase())
  if (month < 0) return null
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

// Titles are compared loosely on punctuation Facebook or an editor may swap
// (curly vs straight quotes, dashes, spacing, case) and strictly on wording.
export function normalizeTitle(text) {
  return (text || '')
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Parse the plain-text comments file. Each video is a block after a line of
 * "=" characters:
 *
 *   VIDEO 019 | Tuesday, October 13, 2026
 *   CHOSEN TITLE: <exact Facebook post text>
 *
 *   PINNED COMMENT:
 *   <comment, posted word for word>
 *
 * Returns { entries, errors }. Anything malformed is an error rather than a
 * guess, because a mis-parsed block would post the wrong text publicly.
 */
export function parseCommentsFile(text) {
  const entries = []
  const errors = []
  const blocks = text.replace(/\r\n/g, '\n').split(/^={10,}\s*$/m).slice(1)

  for (const raw of blocks) {
    const block = raw.trim()
    if (!block) continue
    const head = block.split('\n')[0]
    const video = block.match(/^VIDEO\s+(\S+)\s*\|\s*(.+)$/m)
    const title = block.match(/^CHOSEN TITLE:\s*(.+)$/m)
    const marker = block.match(/^PINNED COMMENT:\s*$/m)

    if (!video || !title || !marker) {
      errors.push(`Block starting "${head.slice(0, 60)}" needs VIDEO, CHOSEN TITLE and PINNED COMMENT lines.`)
      continue
    }
    const date = parseDate(video[2])
    if (!date) {
      errors.push(`VIDEO ${video[1]}: can't read the date "${video[2].trim()}".`)
      continue
    }
    const comment = block.slice(marker.index + marker[0].length).trim()
    if (!comment) {
      errors.push(`VIDEO ${video[1]}: the pinned comment is empty.`)
      continue
    }
    if (/\[LINK_[A-Z0-9_]*\]/.test(comment)) {
      errors.push(`VIDEO ${video[1]}: the comment still has a [LINK_...] placeholder.`)
      continue
    }
    entries.push({ video: video[1], date, title: title[1].trim(), comment })
  }

  const seen = new Map()
  for (const e of entries) {
    const key = normalizeTitle(e.title)
    if (seen.has(key)) errors.push(`VIDEO ${seen.get(key)} and VIDEO ${e.video} have the same title.`)
    else seen.set(key, e.video)
  }
  if (!entries.length && !errors.length) errors.push('No videos found in the comments file.')
  return { entries, errors }
}

// A post matches when its text is the title, or its first line is (so adding
// hashtags or a description under the title on Facebook still matches).
export function findEntry(entries, postText) {
  const full = normalizeTitle(postText)
  const firstLine = normalizeTitle((postText || '').split('\n')[0])
  if (!full) return null
  return entries.find(e => {
    const t = normalizeTitle(e.title)
    return t === full || t === firstLine
  }) || null
}

export function commentDueAt(publishedMs) {
  return publishedMs + COMMENT_DELAY_MS
}

// The comment's links, used to recognise our own comment even if Facebook
// reformats whitespace in the text.
export function linksIn(text) {
  return (text.match(/https?:\/\/[^\s)]+/g) || [])
}

export function isOurComment(fbComment, pageId, entry) {
  if (!fbComment || fbComment.from?.id !== pageId) return false
  const msg = (fbComment.message || '').replace(/\s+/g, ' ').trim()
  if (msg === entry.comment.replace(/\s+/g, ' ').trim()) return true
  const links = linksIn(entry.comment)
  return links.length > 0 && links.every(l => msg.includes(l))
}

/**
 * Decide what to do with one published post. Returns
 * { action: 'wait' | 'done' | 'post' | 'too-late' | 'unmatched', entry, dueMs }
 */
export function decide({ entries, postText, publishedMs, nowMs, comments, pageId }) {
  const entry = findEntry(entries, postText)
  if (!entry) return { action: 'unmatched', entry: null, dueMs: null }
  const dueMs = commentDueAt(publishedMs)
  if ((comments || []).some(c => isOurComment(c, pageId, entry))) return { action: 'done', entry, dueMs }
  if (nowMs < dueMs) return { action: 'wait', entry, dueMs }
  if (nowMs - publishedMs > MAX_LATE_MS) return { action: 'too-late', entry, dueMs }
  return { action: 'post', entry, dueMs }
}

export function formatTime(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DISPLAY_TZ, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(ms)) + ' Jamaica'
}

export function localDate(ms) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TZ }).format(new Date(ms))
}
