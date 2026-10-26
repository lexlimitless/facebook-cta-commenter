#!/usr/bin/env node
// Facebook CTA commenter. Run by .github/workflows/comment.yml.
//
// Reads facebook-pinned-comments.txt, finds the Page's scheduled and
// recently published videos, matches each to its entry by title, and about two
// hours after a video goes live posts that entry's comment as the Page. It then
// opens a GitHub issue reminding Paul to pin it (Meta's API can't pin).
//
// Safe to run as often as you like: before posting it checks the post for a
// comment from the Page carrying the same links, and it never retries a post
// in the same run. In dry-run mode it makes no writes anywhere (no comments,
// no issues) and only writes a report to the job summary.
//
// Env: FB_PAGE_TOKEN, FB_PAGE_ID (secrets), MODE=auto|dry-run,
//      GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER, GITHUB_STEP_SUMMARY.
// The token is only ever sent in an Authorization header and is never logged.

import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  parseCommentsFile, findEntry, decide, formatTime, localDate, COMMENT_DELAY_MS, MAX_LATE_MS,
} from './core.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMENTS_FILE = path.join(ROOT, 'facebook-pinned-comments.txt')
const CONFIG_FILE = path.join(ROOT, 'config.json')
const GRAPH = 'https://graph.facebook.com/v26.0'
const LOOKBACK_MS = MAX_LATE_MS + 24 * 60 * 60 * 1000
const EXPIRY_WARN_MS = 21 * 24 * 60 * 60 * 1000

const token = process.env.FB_PAGE_TOKEN
const pageId = process.env.FB_PAGE_ID
const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
const live = process.env.MODE !== 'dry-run' && config.live === true
const now = Date.now()

const rows = []        // report table: one row per post or entry
const attention = []   // { title, body } items that need Paul
const lines = []       // free-form notes for the report

class GraphError extends Error {}

async function graph(pathAndQuery, { method = 'GET', body } = {}) {
  const res = await fetch(`${GRAPH}/${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `OAuth ${token}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error) {
    throw new GraphError(`${method} ${pathAndQuery.split('?')[0]}: ${json.error?.message || res.status}`)
  }
  return json
}

const q = params => new URLSearchParams(params).toString()

async function checkToken() {
  // debug_token wants the token as input_token; it goes in the query string of
  // this one request, which is never printed.
  const { data } = await graph(`debug_token?${q({ input_token: token })}`)
  if (!data?.is_valid) throw new Error('The Page token is no longer valid. Generate a new one and update the FB_PAGE_TOKEN secret.')
  if (data.type !== 'PAGE') throw new Error(`FB_PAGE_TOKEN is a ${data.type} token; it must be a Page token.`)
  if (String(data.profile_id) !== String(pageId)) throw new Error('FB_PAGE_TOKEN belongs to a different Page than FB_PAGE_ID.')
  if (!(data.scopes || []).includes('pages_manage_engagement')) throw new Error('The token is missing pages_manage_engagement, so it cannot comment.')
  const dae = data.data_access_expires_at ? data.data_access_expires_at * 1000 : 0
  if (dae) {
    lines.push(`Token data access expires ${formatTime(dae)}.`)
    if (dae - now < EXPIRY_WARN_MS) {
      attention.push({
        title: `Facebook CTA: renew the Page token before ${localDate(dae)}`,
        body: `Meta says the token's data access expires on ${formatTime(dae)}. After that the commenter may stop reading posts. Re-authorize the "Claude Author Commenter" app for the Page, generate a fresh Page token and update the FB_PAGE_TOKEN secret.`,
      })
    }
  }
}

// Recently published videos can show up under different edges depending on
// how they were uploaded, so check all of them and merge by post ID.
async function recentPublished() {
  const sources = [
    [`${pageId}/published_posts`, 'id,message,created_time,permalink_url'],
    [`${pageId}/video_reels`, 'id,post_id,description,created_time,permalink_url'],
    [`${pageId}/videos`, 'id,post_id,description,created_time,published,permalink_url'],
  ]
  const byId = new Map()
  for (const [edge, fields] of sources) {
    try {
      const { data = [] } = await graph(`${edge}?${q({ fields, limit: '15' })}`)
      for (const item of data) {
        if (item.published === false) continue
        const raw = item.post_id || item.id
        if (!raw) continue
        const postId = raw.includes('_') ? raw : `${pageId}_${raw}`
        const createdMs = Date.parse(item.created_time)
        if (!createdMs || now - createdMs > LOOKBACK_MS) continue
        const prev = byId.get(postId) || {}
        byId.set(postId, {
          postId,
          text: prev.text || item.message || item.description || '',
          createdMs: Math.max(prev.createdMs || 0, createdMs),
          url: prev.url || item.permalink_url,
        })
      }
    } catch (err) {
      lines.push(`Couldn't read ${edge.split('/')[1]} (${err.message}); using the other lists.`)
    }
  }
  // Read each post directly for its exact text and publish state.
  const posts = []
  for (const p of byId.values()) {
    try {
      const d = await graph(`${p.postId}?${q({ fields: 'id,message,created_time,is_published,permalink_url' })}`)
      if (d.is_published === false) continue
      posts.push({ ...p, text: d.message || p.text, createdMs: Date.parse(d.created_time) || p.createdMs, url: d.permalink_url || p.url })
    } catch {
      posts.push(p)
    }
  }
  return posts
}

async function scheduled() {
  const { data = [] } = await graph(`${pageId}/scheduled_posts?${q({ fields: 'id,message,scheduled_publish_time', limit: '50' })}`)
  return data.map(d => ({ postId: d.id, text: d.message || '', publishMs: d.scheduled_publish_time * 1000 }))
}

async function pageComments(postId) {
  const { data = [] } = await graph(`${postId}/comments?${q({ fields: 'id,message,from{id},created_time', filter: 'stream', order: 'reverse_chronological', limit: '100' })}`)
  return data
}

async function githubIssue({ title, body }) {
  const repo = process.env.GITHUB_REPOSITORY
  const gh = (p, init = {}) => fetch(`https://api.github.com/repos/${repo}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  const open = await (await gh('/issues?state=open&per_page=100')).json()
  if (Array.isArray(open) && open.some(i => i.title === title)) return
  const owner = process.env.GITHUB_REPOSITORY_OWNER
  const res = await gh('/issues', { method: 'POST', body: JSON.stringify({ title, body, assignees: owner ? [owner] : [] }) })
  if (!res.ok) console.error(`Could not open issue "${title}": ${res.status}`)
}

function quote(text) {
  return text.split('\n').map(l => `> ${l}`).join('\n')
}

async function handlePublished(post, entries) {
  const entry = findEntry(entries, post.text)
  if (!entry) {
    // Report only: the Page may publish things that aren't in the plan. Title
    // typos are caught earlier, while the video is still scheduled.
    rows.push(['Published', formatTime(post.createdMs), post.text.split('\n')[0] || '(no text)', '—', 'No matching title in the comments file'])
    return
  }
  const comments = await pageComments(post.postId)
  const d = decide({ entries, postText: post.text, publishedMs: post.createdMs, nowMs: now, comments, pageId })
  const label = `VIDEO ${entry.video}`
  if (d.action === 'done') return rows.push(['Published', formatTime(post.createdMs), entry.title, label, 'Comment already posted'])
  if (d.action === 'wait') return rows.push(['Published', formatTime(post.createdMs), entry.title, label, `Comment due ${formatTime(d.dueMs)}`])
  if (d.action === 'too-late') {
    rows.push(['Published', formatTime(post.createdMs), entry.title, label, 'More than 3 days live without the comment; not posting'])
    attention.push({
      title: `Facebook CTA: comment missed for VIDEO ${entry.video}`,
      body: `"${entry.title}" went live ${formatTime(post.createdMs)} and still has no CTA comment. The commenter doesn't post this late; add it by hand if you still want it.\n\nPost: ${post.url || post.postId}\n\n${quote(entry.comment)}`,
    })
    return
  }
  // action === 'post'
  if (!live) return rows.push(['Published', formatTime(post.createdMs), entry.title, label, 'Would post the comment now (dry run)'])

  let commentId
  try {
    const res = await graph(`${post.postId}/comments`, { method: 'POST', body: { message: entry.comment } })
    commentId = res.id
  } catch (err) {
    // No retry: if the request reached Facebook, the next run will see the
    // comment and skip; if it didn't, the next run posts it.
    rows.push(['Published', formatTime(post.createdMs), entry.title, label, `Posting failed: ${err.message}`])
    attention.push({ title: `Facebook CTA: posting failed for VIDEO ${entry.video}`, body: `${err.message}\n\nPost: ${post.url || post.postId}\n\nThe next run will try again if it's still within 3 days.` })
    return
  }
  rows.push(['Published', formatTime(post.createdMs), entry.title, label, `Comment posted (${commentId})`])
  await githubIssue({
    title: `Pin the CTA comment on VIDEO ${entry.video}`,
    body: `The CTA comment was posted on "${entry.title}". Open the post and pin it, then close this issue.\n\nPost: ${post.url || post.postId}\n\n${quote(entry.comment)}`,
  })
}

function report(entries, matchedVideos) {
  // Entries going live soon or recently that Facebook doesn't show at all.
  for (const e of entries) {
    if (matchedVideos.has(e.video)) continue
    const dayMs = Date.parse(`${e.date}T12:00:00-05:00`)
    if (dayMs > now + 30 * 86400000 || dayMs < now - 3 * 86400000) continue
    rows.push(['In file only', e.date, e.title, `VIDEO ${e.video}`, 'Not scheduled on Facebook yet'])
  }

  const out = [
    `## Facebook CTA commenter: ${live ? 'LIVE' : 'dry run'}`,
    '',
    `Run at ${formatTime(now)}. ${entries.length} videos in the comments file.`,
    ...lines.map(l => `- ${l}`),
    '',
    '| Status | When | Title | Video | What happens |',
    '|---|---|---|---|---|',
    ...rows.map(r => `| ${r.map(c => String(c).replace(/\|/g, '\\|')).join(' | ')} |`),
    '',
  ]
  if (attention.length) {
    out.push('### Needs attention', '', ...attention.map(a => `- **${a.title}**: ${a.body.split('\n')[0]}`), '')
  }
  if (!live) {
    out.push('### Comments that will be posted', '')
    for (const e of entries.filter(x => matchedVideos.has(x.video))) {
      out.push(`**VIDEO ${e.video}: ${e.title}**`, '', quote(e.comment), '')
    }
  }
  const md = out.join('\n')
  console.log(md)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
}

async function main() {
  if (!token || !pageId) throw new Error('FB_PAGE_TOKEN and FB_PAGE_ID must be set as repository secrets.')
  const { entries, errors } = parseCommentsFile(readFileSync(COMMENTS_FILE, 'utf8'))
  if (errors.length) {
    // Refuse to post anything while the file is half-readable.
    throw new Error(`The comments file has problems:\n- ${errors.join('\n- ')}`)
  }
  await checkToken()

  const matchedVideos = new Set()
  for (const s of await scheduled()) {
    const entry = findEntry(entries, s.text)
    if (entry) matchedVideos.add(entry.video)
    rows.push(['Scheduled', formatTime(s.publishMs), entry?.title || s.text.split('\n')[0],
      entry ? `VIDEO ${entry.video}` : '—',
      entry ? `Comment due about ${formatTime(s.publishMs + COMMENT_DELAY_MS)}` : 'No matching title in the comments file'])
    if (entry && localDate(s.publishMs) !== entry.date) {
      lines.push(`VIDEO ${entry.video} is scheduled for ${localDate(s.publishMs)} but the file says ${entry.date}. It's matched by title, so the comment still goes on the right post.`)
    }
    if (!entry) {
      attention.push({
        title: `Facebook CTA: scheduled video has no comment: "${(s.text.split('\n')[0] || s.postId).slice(0, 80)}"`,
        body: `A video scheduled for ${formatTime(s.publishMs)} doesn't match any CHOSEN TITLE in facebook-pinned-comments.txt. Fix the title before it goes live, or it won't get a comment.`,
      })
    }
  }

  for (const post of await recentPublished()) {
    const entry = findEntry(entries, post.text)
    if (entry) matchedVideos.add(entry.video)
    await handlePublished(post, entries)
  }

  report(entries, matchedVideos)
  if (live) for (const a of attention) await githubIssue(a)
}

main().catch(async err => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`Facebook CTA commenter failed: ${msg}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Facebook CTA commenter failed\n\n${msg}\n`)
  if (live && process.env.GITHUB_TOKEN) {
    await githubIssue({ title: 'Facebook CTA: the commenter is failing', body: `${msg}\n\nNo comments are being posted until this is fixed.` }).catch(() => {})
  }
  process.exit(1)
})
