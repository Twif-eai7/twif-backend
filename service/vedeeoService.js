/**
 * Vedeeo (meet.vedeeo.com) call-invite client.
 * Auth: X-API-Key from VIDEOMEET_API_KEY. Base URL: VIDEOMEET_BASE_URL.
 */

const BASE = String(process.env.VIDEOMEET_BASE_URL || '').replace(/\/$/, '')
const KEY  = String(process.env.VIDEOMEET_API_KEY || '').trim()

function isConfigured() {
  return Boolean(BASE && KEY)
}

function clip(value, max) {
  if (value == null) return value
  const s = String(value).trim()
  if (!s) return s
  return s.length <= max ? s : s.slice(0, max)
}

function asInvite(data) {
  if (!data || typeof data !== 'object') return data
  if (data.inviteId) return data
  if (data.invite?.inviteId) return data.invite
  if (data.data?.inviteId) return data.data
  return data
}

function asInviteList(data) {
  if (Array.isArray(data)) return data.map(asInvite).filter(Boolean)
  if (Array.isArray(data?.invites)) return data.invites.map(asInvite).filter(Boolean)
  if (Array.isArray(data?.data)) return data.data.map(asInvite).filter(Boolean)
  const one = asInvite(data)
  return one?.inviteId ? [one] : []
}

function inviteStatus(invite) {
  return String(invite?.status || '').toUpperCase()
}

function isRinging(invite) {
  return inviteStatus(invite) === 'RINGING'
}

function isAccepted(invite) {
  const s = inviteStatus(invite)
  return s === 'ACCEPTED' || s === 'ACTIVE' || s === 'JOINED'
}

function isClosed(invite) {
  const s = inviteStatus(invite)
  return ['DECLINED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'ENDED'].includes(s)
}

function isInviteExpired(invite) {
  if (!invite?.expiresAt) return false
  const ts = Date.parse(invite.expiresAt)
  return !Number.isNaN(ts) && ts <= Date.now()
}

function isOpenInvite(invite) {
  if (!invite?.inviteId || isClosed(invite)) return false
  if (isAccepted(invite)) return true
  if (isRinging(invite)) return !isInviteExpired(invite)
  return false
}

function userIsOnInvite(invite, userId) {
  if (!invite || !userId) return false
  return invite.callerUserId === userId || invite.calleeUserId === userId
}

function hasRoomId(joinUrl) {
  if (typeof joinUrl !== 'string' || !joinUrl.trim()) return false
  try {
    return Boolean(new URL(joinUrl).searchParams.get('roomId'))
  } catch {
    return /[?&]roomId=/.test(joinUrl)
  }
}

function toEmbedJoinUrl(joinUrl, displayName) {
  if (!joinUrl) return joinUrl
  const name = displayName ? clip(displayName, 80) : ''
  try {
    const url = new URL(joinUrl)
    // Vedeeo's meeting UI is room.html. embed.html is a name gate and has no token.
    if (url.pathname.endsWith('/embed.html') || url.pathname === '/embed.html') {
      url.pathname = url.pathname.replace(/embed\.html$/, 'room.html')
    }
    url.searchParams.set('embed', '1')
    if (name && !url.searchParams.get('name')) url.searchParams.set('name', name)
    return url.toString()
  } catch {
    const sep = joinUrl.includes('?') ? '&' : '?'
    const bits = ['embed=1']
    if (name && !/[?&]name=/.test(joinUrl)) bits.push(`name=${encodeURIComponent(name)}`)
    return `${joinUrl}${sep}${bits.join('&')}`
  }
}

function pickRawJoinUrl(invite, role) {
  if (!invite || typeof invite !== 'object') return null
  const hostFirst = [
    invite.hostJoinUrl, invite.guestJoinUrl, invite.notification?.joinUrl,
    invite.embedJoinUrl, invite.joinUrl,
  ]
  const guestFirst = [
    invite.guestJoinUrl, invite.notification?.joinUrl, invite.hostJoinUrl,
    invite.embedJoinUrl, invite.joinUrl,
  ]
  const list = role === 'host' ? hostFirst : guestFirst
  return list.find((u) => hasRoomId(u)) || list.find((u) => typeof u === 'string' && u.trim()) || null
}

function joinUrlForRole(invite, role, displayName) {
  return toEmbedJoinUrl(pickRawJoinUrl(invite, role), displayName)
}

class VedeeoError extends Error {
  constructor(message, status, data) {
    super(message)
    this.name = 'VedeeoError'
    this.status = status || 500
    this.data = data
  }
}

async function vedeeoFetch(path, { method = 'GET', body } = {}) {
  if (!isConfigured()) {
    throw new VedeeoError('Video calls not configured — VIDEOMEET_BASE_URL or VIDEOMEET_API_KEY missing', 500)
  }
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const msg = data?.error || data?.message || data?.info || `Vedeeo error ${resp.status}`
    if (resp.status === 401 || resp.status === 403) {
      throw new VedeeoError('Vedeeo rejected the API key — check VIDEOMEET_API_KEY', resp.status, data)
    }
    throw new VedeeoError(msg, resp.status, data)
  }
  return data
}

async function createInvite({ conversationId, callerUserId, callerName, calleeUserId, calleeName, title }) {
  return asInvite(await vedeeoFetch('/api/v1/call-invites', {
    method: 'POST',
    body: {
      conversationId: clip(conversationId, 120),
      callerUserId:   clip(callerUserId, 120),
      callerName:     clip(callerName, 80),
      calleeUserId:   clip(calleeUserId, 120),
      ...(calleeName ? { calleeName: clip(calleeName, 80) } : {}),
      ...(title ? { title: clip(title, 120) } : {}),
    },
  }))
}

async function getInvite(inviteId) {
  return asInvite(await vedeeoFetch(`/api/v1/call-invites/${encodeURIComponent(inviteId)}`))
}

async function listPending(calleeUserId) {
  const q = new URLSearchParams({ calleeUserId: clip(calleeUserId, 120) })
  return asInviteList(await vedeeoFetch(`/api/v1/call-invites/pending?${q}`))
}

async function listByConversation(conversationId) {
  const q = new URLSearchParams({ conversationId: clip(conversationId, 120) })
  return asInviteList(await vedeeoFetch(`/api/v1/call-invites?${q}`))
}

async function acceptInvite(inviteId, userId) {
  return asInvite(await vedeeoFetch(`/api/v1/call-invites/${encodeURIComponent(inviteId)}/accept`, {
    method: 'POST',
    body: { userId: clip(userId, 120) },
  }))
}

async function declineInvite(inviteId, userId) {
  return asInvite(await vedeeoFetch(`/api/v1/call-invites/${encodeURIComponent(inviteId)}/decline`, {
    method: 'POST',
    body: { userId: clip(userId, 120) },
  }))
}

async function cancelInvite(inviteId, userId) {
  return asInvite(await vedeeoFetch(`/api/v1/call-invites/${encodeURIComponent(inviteId)}/cancel`, {
    method: 'POST',
    body: { userId: clip(userId, 120) },
  }))
}

async function getRoom(roomId) {
  if (!roomId) return null
  try {
    return await vedeeoFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}`)
  } catch (err) {
    if (err.status === 404) return null
    throw err
  }
}

async function roomIsLive(roomId) {
  const room = await getRoom(roomId)
  if (!room) return false
  const status = String(room.status || '').toUpperCase()
  return !['ENDED', 'EXPIRED', 'CLOSED', 'CANCELLED', 'CANCELED'].includes(status)
}

async function deleteRoom(roomId) {
  if (!roomId) return
  try {
    await vedeeoFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' })
  } catch {
    /* already gone */
  }
}

async function findOpenInvite(conversationId, userId, storedInviteId) {
  let invites = []
  try {
    invites = await listByConversation(conversationId)
  } catch {
    invites = []
  }
  if (storedInviteId && !invites.some(i => i.inviteId === storedInviteId)) {
    try {
      const one = await getInvite(storedInviteId)
      if (one) invites.push(one)
    } catch { /* expired / unknown */ }
  }
  const mine = invites.filter(i => isOpenInvite(i) && userIsOnInvite(i, userId))
  for (const invite of mine) {
    if (invite.roomId && await roomIsLive(invite.roomId)) return invite
  }
  return null
}

async function cancelOpenInvites(conversationId, userId, exceptInviteId) {
  let invites = []
  try {
    invites = await listByConversation(conversationId)
  } catch {
    return
  }
  for (const invite of invites) {
    if (!invite?.inviteId || invite.inviteId === exceptInviteId) continue
    if (invite.callerUserId !== userId) continue
    if (!isRinging(invite) && !isAccepted(invite)) continue
    try { await cancelInvite(invite.inviteId, userId) } catch { /* already closed */ }
    await deleteRoom(invite.roomId)
  }
}

module.exports = {
  VedeeoError,
  isConfigured,
  clip,
  asInvite,
  asInviteList,
  inviteStatus,
  isRinging,
  isAccepted,
  isClosed,
  isInviteExpired,
  isOpenInvite,
  userIsOnInvite,
  hasRoomId,
  toEmbedJoinUrl,
  pickRawJoinUrl,
  joinUrlForRole,
  createInvite,
  getInvite,
  getRoom,
  roomIsLive,
  deleteRoom,
  listPending,
  listByConversation,
  acceptInvite,
  declineInvite,
  cancelInvite,
  findOpenInvite,
  cancelOpenInvites,
}
