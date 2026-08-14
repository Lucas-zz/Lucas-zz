import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DISCORD_USER_ID = '186683033959530496'
const LANYARD_URL = `https://api.lanyard.rest/v1/users/${DISCORD_USER_ID}`
const OUTPUT_DIRECTORY = process.argv[2] ?? 'presence-badges'

const EDITOR_NAMES = new Set([
  'Code',
  'Cursor',
  'Visual Studio Code',
  'VSCodium',
  'WebStorm',
])

const STATUS_COLORS = {
  online: 'brightgreen',
  idle: 'yellow',
  dnd: 'red',
  offline: 'lightgrey',
}

function escapeBadgeSegment(value) {
  return encodeURIComponent(value.replaceAll('-', '--').replaceAll('_', '__'))
}

function compact(value, maximumLength = 34) {
  const normalized = value.replace(/\s+/g, ' ').trim()

  if (normalized.length <= maximumLength) {
    return normalized
  }

  return `${normalized.slice(0, maximumLength - 1).trimEnd()}…`
}

function codingMessage(activity) {
  if (!activity) {
    return 'nothing rn'
  }

  const workspace = activity.details?.match(/^In (.+?)(?: \(Workspace\))?(?: -|$)/i)?.[1]
  return compact(workspace ?? activity.name)
}

function badgeUrl({ label, message, color, logo }) {
  const badge = `${escapeBadgeSegment(label)}-${escapeBadgeSegment(message)}-${color}`
  const query = new URLSearchParams({ style: 'flat', logoColor: 'white' })

  if (logo) {
    query.set('logo', logo)
  }

  return `https://img.shields.io/badge/${badge}?${query}`
}

async function downloadBadge(filename, options) {
  const response = await fetch(badgeUrl(options), {
    headers: { 'User-Agent': 'Lucas-zz/Lucas-zz presence badge updater' },
  })

  if (!response.ok) {
    throw new Error(`Shields returned ${response.status} for ${filename}`)
  }

  const svg = await response.text()

  if (!svg.startsWith('<svg') || !svg.includes('<title>')) {
    throw new Error(`Shields returned an invalid SVG for ${filename}`)
  }

  await writeFile(path.join(OUTPUT_DIRECTORY, filename), svg)
}

const lanyardResponse = await fetch(LANYARD_URL, {
  headers: { 'User-Agent': 'Lucas-zz/Lucas-zz presence badge updater' },
})

if (!lanyardResponse.ok) {
  throw new Error(`Lanyard returned ${lanyardResponse.status}`)
}

const lanyard = await lanyardResponse.json()

if (!lanyard.success || !lanyard.data) {
  throw new Error('Lanyard did not return presence data')
}

const { activities = [], discord_status: status, spotify } = lanyard.data
const coding = activities.find(
  activity => activity.type === 0 && EDITOR_NAMES.has(activity.name),
)
const playing = activities.find(
  activity =>
    activity.type === 0 &&
    !EDITOR_NAMES.has(activity.name) &&
    activity.name !== 'Spotify',
)

await mkdir(OUTPUT_DIRECTORY, { recursive: true })

await Promise.all([
  downloadBadge('status.svg', {
    label: 'currently',
    message: status,
    color: STATUS_COLORS[status] ?? 'lightgrey',
  }),
  downloadBadge('playing.svg', {
    label: 'playing',
    message: compact(playing?.name ?? 'nothing rn'),
    color: playing ? '5865F2' : '8A63D2',
  }),
  downloadBadge('coding.svg', {
    label: 'coding',
    message: codingMessage(coding),
    color: '007ACC',
    logo: 'visualstudiocode',
  }),
  downloadBadge('spotify.svg', {
    label: 'listening to',
    message: spotify
      ? compact(`${spotify.song} · ${spotify.artist}`)
      : 'nothing rn',
    color: '1DB954',
    logo: 'spotify',
  }),
])

console.log(
  JSON.stringify({
    status,
    playing: playing?.name ?? null,
    coding: codingMessage(coding),
    spotify: spotify ? `${spotify.song} · ${spotify.artist}` : null,
  }),
)
