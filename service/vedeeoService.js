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

function isOpenInvite(invite) {
  if (!invite?.inviteId || isClosed(invite)) return false
  if (isAccepted(invite)) return true
  if (isRinging(invite)) {
    if (invite?.expiresAt && !Number.isNaN(Date.parse(invite.expiresAt))) {
      return new Date(invite.expiresAt) > new Date()
    }
    return true
  }
  return false
}

function userIsOnInvite(invite, userId) {
  if (!invite || !userId) return false
  return invite.callerUserId === userId || invite.calleeUserId === userId
}

function toEmbedJoinUrl(joinUrl, displayName) {
  if (!joinUrl) return joinUrl
  const name = displayName ? clip(displayName, 80) : ''
  try {
    const url = new URL(joinUrl)
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

function joinUrlForRole(invite, role, displayName) {
  const raw = role === 'host'
    ? (invite?.hostJoinUrl || invite?.embedJoinUrl)
    : (invite?.guestJoinUrl || invite?.notification?.joinUrl || invite?.embedJoinUrl)
  return toEmbedJoinUrl(raw, displayName)
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
  return invites.find(i => isOpenInvite(i) && userIsOnInvite(i, userId)) || null
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
  isOpenInvite,
  userIsOnInvite,
  toEmbedJoinUrl,
  joinUrlForRole,
  createInvite,
  getInvite,
  listPending,
  listByConversation,
  acceptInvite,
  declineInvite,
  cancelInvite,
  findOpenInvite,
}
