import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DISCORD_USER_ID = '186683033959530496'
const LANYARD_URL = process.env.LANYARD_URL ??
  `https://api.lanyard.rest/v1/users/${DISCORD_USER_ID}`
const STATUS_BADGES_URL = process.env.STATUS_BADGES_URL ??
  `https://api.statusbadges.me/presence/${DISCORD_USER_ID}`
const OUTPUT_DIRECTORY = process.argv[2] ?? 'presence-badges'
const PREVIOUS_STATE_FILE = process.argv[3]
const ACTIVITY_GRACE_PERIOD_MS = 15 * 60 * 1000

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

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Lucas-zz/Lucas-zz presence badge updater' },
    })

    if (!response.ok) {
      return null
    }

    return await response.json()
  } catch {
    return null
  }
}

async function readPreviousState() {
  if (!PREVIOUS_STATE_FILE) {
    return null
  }

  try {
    return JSON.parse(await readFile(PREVIOUS_STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function normalizeStatusBadges(data) {
  const activities = Array.isArray(data?.activities) ? data.activities : []
  const hasActiveClient = Object.keys(data?.client_status ?? {}).length > 0
  const hasObservablePresence =
    activities.length > 0 || hasActiveClient || data?.status !== 'offline'

  if (!data?.status || !hasObservablePresence) {
    return null
  }

  const spotifyActivity = activities.find(
    activity => activity.type === 2 && activity.name === 'Spotify',
  )

  return {
    provider: 'statusbadges',
    status: data.status,
    activities,
    spotify: spotifyActivity
      ? { song: spotifyActivity.details, artist: spotifyActivity.state }
      : null,
  }
}

function retainRecentActivity(key, currentValue, status, previousState, now) {
  if (currentValue) {
    return { value: currentValue, lastSeenAt: now }
  }

  const previous = previousState?.activities?.[key]
  const isRecent =
    previous?.value &&
    Number.isFinite(previous.lastSeenAt) &&
    now - previous.lastSeenAt <= ACTIVITY_GRACE_PERIOD_MS

  if (status !== 'offline' && isRecent) {
    return previous
  }

  return { value: null, lastSeenAt: previous?.lastSeenAt ?? null }
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

const [lanyard, statusBadges, previousState] = await Promise.all([
  fetchJson(LANYARD_URL),
  fetchJson(STATUS_BADGES_URL),
  readPreviousState(),
])
const lanyardPresence = lanyard?.success && lanyard.data
  ? {
      provider: 'lanyard',
      status: lanyard.data.discord_status,
      activities: lanyard.data.activities ?? [],
      spotify: lanyard.data.spotify,
    }
  : null
const statusBadgesPresence = normalizeStatusBadges(statusBadges)
const presence = statusBadgesPresence ?? lanyardPresence

const now = Date.now()
const cachedStateWithinGracePeriod =
  previousState?.generatedAt &&
  now - previousState.generatedAt <= ACTIVITY_GRACE_PERIOD_MS

const fallbackPresence = !presence
  ? null
  : presence === statusBadgesPresence
    ? lanyardPresence
    : statusBadgesPresence
const fallbackActivities = fallbackPresence?.activities ?? []
const activities = presence
  ? presence.activities.length > 0
    ? presence.activities
    : fallbackActivities
  : []
const status = presence?.status ?? null
const spotify = presence?.spotify ?? fallbackPresence?.spotify ?? null
const providers = presence ? new Set([presence.provider]) : new Set()

if (presence && presence.activities.length === 0 && fallbackActivities.length > 0) {
  providers.add(fallbackPresence.provider)
}

if (presence && !presence.spotify && fallbackPresence?.spotify) {
  providers.add(fallbackPresence.provider)
}

const provider = [...providers].join('+')
const coding = activities.find(
  activity => activity.type === 0 && EDITOR_NAMES.has(activity.name),
)
const playing = activities.find(
  activity =>
    activity.type === 0 &&
    !EDITOR_NAMES.has(activity.name) &&
    activity.name !== 'Spotify',
)
const stateForRetain =
  presence || cachedStateWithinGracePeriod ? previousState : null
const activityState = {
  playing: retainRecentActivity(
    'playing',
    playing?.name ?? null,
    status,
    stateForRetain,
    now,
  ),
  coding: retainRecentActivity(
    'coding',
    coding ? codingMessage(coding) : null,
    status,
    stateForRetain,
    now,
  ),
  spotify: retainRecentActivity(
    'spotify',
    spotify ? compact(`${spotify.song} · ${spotify.artist}`) : null,
    status,
    stateForRetain,
    now,
  ),
}

await mkdir(OUTPUT_DIRECTORY, { recursive: true })

await Promise.all([
  downloadBadge('status.svg', {
    label: 'currently',
    message: status ?? 'unavailable',
    color: STATUS_COLORS[status] ?? 'lightgrey',
  }),
  downloadBadge('playing.svg', {
    label: 'playing',
    message: compact(activityState.playing.value ?? 'nothing rn'),
    color: activityState.playing.value ? '5865F2' : '8A63D2',
  }),
  downloadBadge('coding.svg', {
    label: 'coding',
    message: activityState.coding.value ?? 'nothing rn',
    color: '007ACC',
    logo: 'visualstudiocode',
  }),
  downloadBadge('spotify.svg', {
    label: 'listening to',
    message: activityState.spotify.value ?? 'nothing rn',
    color: '1DB954',
    logo: 'spotify',
  }),
])

await writeFile(
  path.join(OUTPUT_DIRECTORY, 'presence.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: now,
    provider,
    status,
    activities: activityState,
  }, null, 2)}\n`,
)

console.log(
  JSON.stringify({
    provider,
    status,
    playing: activityState.playing.value,
    coding: activityState.coding.value,
    spotify: activityState.spotify.value,
  }),
)
