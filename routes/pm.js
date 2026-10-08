/**
 * routes/pm.js — Project Management module
 * Mounted at /pm in server.js
 * Phase 1: Projects, Boards, Columns, Tasks (no attachments/comments yet)
 */

const express  = require('express')
const router   = express.Router()
const sanitizeHtml = require('sanitize-html')
const supabase = require('../supabaseClient')
const upload = require('../upload')
const { requireAuth } = require('../middleware/auth')
const { sendAlertEmail } = require('../service/emailService')
const { spawnNextOccurrence } = require('../service/pmRecurrence')

const PM_BUCKET = 'npd'
const PM_PREFIX = 'pm'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the calling user's organization_members row */
async function resolveMember(userId) {
  const { data } = await supabase
    .from('organization_members')
    .select('id, role, department, organization_id, organizations(id, type)')
    .eq('user_id', userId)
    .maybeSingle()
  return data || null
}

/**
 * Returns true for merchant admins/owners — they bypass project membership
 * checks and can read/write any project in their org.
 */
function isSuperAdmin(member) {
  if (!member) return false
  const orgType = member.organizations?.type
  return (
    orgType === 'merchant' &&
    ['admin', 'owner'].includes(member.role)
  )
}

/** Merchant tech-admins already pass isSuperAdmin; kept as an explicit alias. */
function isPmAdmin(member) {
  return isSuperAdmin(member)
}

/**
 * Resolve this member's role in a given project.
 * Returns 'owner' | 'editor' | 'commenter' | 'viewer' | null
 */
async function resolvePmRole(projectId, memberId) {
  const { data } = await supabase
    .from('pm_project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('member_id', memberId)
    .maybeSingle()
  return data?.role ?? null
}

/** Insert a pm_activity_log row — fire-and-forget, never throw */
async function logActivity(projectId, taskId, actorMemberId, action, meta = {}) {
  try {
    await supabase.from('pm_activity_log').insert({
      project_id: projectId,
      task_id: taskId,
      actor_member_id: actorMemberId,
      action,
      meta,
    })
  } catch (_) {}
}

/** Fractional index mid-point between two numbers (for drag-and-drop ordering) */
function midPos(before, after) {
  if (before == null && after == null) return 65536
  if (before == null) return after / 2
  if (after == null) return before + 65536
  return (before + after) / 2
}

const DEFAULT_REMINDERS = [
  { offset_minutes: 1440, channel: 'both' },
  { offset_minutes: 120,  channel: 'both' },
  { offset_minutes: 30,   channel: 'inapp' },
]

const sanitizeRichComment = (html) => sanitizeHtml(html, {
  allowedTags: ['b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'br', 'span', 'p', 'div', 'img', 'a'],
  allowedAttributes: {
    span: ['style', 'data-member-id'],
    p: ['style'],
    div: ['style'],
    li: ['style'],
    ul: ['style'],
    img: ['src', 'style', 'alt'],
    a: ['href', 'target', 'rel'],
  },
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\)$/],
      'background-color': [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\)$/],
      'font-size': [/^\d{1,3}(px|pt)$/],
      'font-weight': [/^(bold|normal|\d{3})$/],
      width: [/^\d{1,4}px$/],
      height: [/^\d{1,4}px$/, /^auto$/],
      'max-width': [/^(100%|\d{1,4}px)$/],
    },
  },
  allowedSchemes: ['https'],
})

async function loadTask(taskId) {
  const { data } = await supabase.from('pm_tasks').select('*').eq('id', taskId).maybeSingle()
  return data || null
}

async function assertTaskAccess(member, task, write = false) {
  if (!member || !task) return null
  const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
  if (!pmRole) return null
  if (write && (pmRole === 'viewer')) return null
  return pmRole
}

async function memberEmails(memberIds) {
  if (!memberIds?.length) return []
  const { data } = await supabase
    .from('organization_members')
    .select('id, full_name, email')
    .in('id', memberIds)
  return (data || []).filter(m => m.email)
}

async function insertNotification({ memberId, taskId, projectId, type, title, body }) {
  const { data } = await supabase.from('pm_notifications').insert({
    member_id: memberId,
    task_id: taskId || null,
    project_id: projectId || null,
    type,
    title,
    body: body || null,
  }).select().maybeSingle()
  return data
}

async function wantsEmail(memberId, prefKey) {
  const { data } = await supabase
    .from('pm_notification_preferences')
    .select('preferences')
    .eq('member_id', memberId)
    .maybeSingle()
  const prefs = data?.preferences || {}
  if (prefKey in prefs) return !!prefs[prefKey]
  return true
}

async function notifyMembers({ memberIds, actorId, task, type, title, emailType, emailMessage }) {
  const ids = [...new Set((memberIds || []).filter(id => id && id !== actorId))]
  if (!ids.length || !task) return
  const members = await memberEmails(ids)
  const { data: project } = await supabase.from('pm_projects').select('title').eq('id', task.project_id).maybeSingle()
  const { data: actor } = actorId
    ? await supabase.from('organization_members').select('full_name').eq('id', actorId).maybeSingle()
    : { data: null }
  const details = {
    task_title: task.title,
    project_title: project?.title,
    priority: task.priority,
    due_date: task.due_date ? new Date(task.due_date).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—',
    actor_name: actor?.full_name,
  }
  for (const m of members) {
    await insertNotification({
      memberId: m.id,
      taskId: task.id,
      projectId: task.project_id,
      type,
      title,
      body: emailMessage || title,
    })
    if (emailType && await wantsEmail(m.id, type === 'mentioned' ? 'on_mentioned' : type === 'assigned' ? 'on_assigned' : 'email_1_day_before')) {
      try {
        await sendAlertEmail([{ email: m.email, name: m.full_name }], emailMessage || title, details, emailType)
      } catch (err) {
        console.error('PM email failed:', err.message)
      }
    }
  }
}

async function seedDefaultReminders(task, memberIds) {
  if (!task?.due_date) return
  const ids = [...new Set((memberIds || []).filter(Boolean))]
  if (!ids.length) return
  const rows = []
  for (const memberId of ids) {
    for (const rem of DEFAULT_REMINDERS) {
      rows.push({
        task_id: task.id,
        member_id: memberId,
        offset_minutes: rem.offset_minutes,
        channel: rem.channel,
      })
    }
  }
  if (rows.length) {
    await supabase.from('pm_task_reminders').upsert(rows, { onConflict: 'task_id,member_id,offset_minutes', ignoreDuplicates: true })
  }
}

async function resetRemindersForDueDate(task) {
  await supabase.from('pm_task_reminders').delete().eq('task_id', task.id).is('sent_at', null)
  const { data: assignees } = await supabase.from('pm_task_assignees').select('member_id').eq('task_id', task.id)
  await seedDefaultReminders(task, (assignees || []).map(a => a.member_id))
}

function parseMentionIds(body, explicit = []) {
  const fromHtml = [...String(body || '').matchAll(/data-member-id=["']([0-9a-f-]{36})["']/gi)].map(m => m[1])
  return [...new Set([...(explicit || []), ...fromHtml])]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function safeSearch(q) {
  return String(q || '').trim().slice(0, 80).replace(/[%_]/g, '')
}

function memberOrgId(member) {
  return member?.organization_id || member?.organizations?.id || null
}

async function firstWritableColumn(projectId) {
  const { data: boards } = await supabase
    .from('pm_boards')
    .select('id')
    .eq('project_id', projectId)
    .order('position')
    .limit(1)
  if (!boards?.length) return null
  const { data: cols } = await supabase
    .from('pm_columns')
    .select('id, name, project_id, board_id')
    .eq('board_id', boards[0].id)
    .order('position')
  if (!cols?.length) return null
  return cols.find(c => /to\s*do/i.test(c.name || '')) || cols[0]
}

async function resolvePoId({ po_id, po_number }) {
  if (po_id && UUID_RE.test(po_id)) return po_id
  const num = String(po_number || '').trim()
  if (!num) return null
  const { data } = await supabase
    .from('purchase_orders')
    .select('id')
    .ilike('po_number', num)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  return data?.id || null
}

async function createTaskInColumn(member, col, body = {}) {
  const { data: last } = await supabase
    .from('pm_tasks')
    .select('position')
    .eq('column_id', col.id)
    .is('deleted_at', null)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const {
    title, description, priority = 'normal',
    due_date, estimate_hours, labels = [],
    linked_po_id, linked_workspace_id, linked_inspection_id, linked_pct_stage,
    assignee_ids = [],
    checklist = [],
  } = body

  const { data: task, error: tErr } = await supabase
    .from('pm_tasks')
    .insert({
      project_id: col.project_id,
      board_id: col.board_id,
      column_id: col.id,
      title: String(title).trim(),
      description: description || null,
      priority,
      position: (last?.position ?? 0) + 65536,
      due_date: due_date || null,
      estimate_hours: estimate_hours || null,
      labels: Array.isArray(labels) ? labels : [],
      linked_po_id: linked_po_id || null,
      linked_workspace_id: linked_workspace_id || null,
      linked_inspection_id: linked_inspection_id || null,
      linked_pct_stage: linked_pct_stage || null,
      created_by_member_id: member.id,
    })
    .select()
    .single()
  if (tErr) throw tErr

  const allAssignees = assignee_ids.includes(member.id) ? assignee_ids : [member.id, ...assignee_ids]
  if (allAssignees.length) {
    await supabase.from('pm_task_assignees').insert(
      allAssignees.map(mid => ({ task_id: task.id, member_id: mid, assigned_by_member_id: member.id }))
    )
  }
  if (checklist.length) {
    await supabase.from('pm_checklists').insert(
      checklist.map((c, i) => ({ task_id: task.id, title: c.title || c, position: i }))
    )
  }

  await logActivity(col.project_id, task.id, member.id, 'task_created', { title: task.title, column: col.id })
  await seedDefaultReminders(task, allAssignees)
  await notifyMembers({
    memberIds: allAssignees,
    actorId: member.id,
    task,
    type: 'assigned',
    title: `Assigned: ${task.title}`,
    emailType: 'PM_TASK_ASSIGNED',
    emailMessage: `You were assigned "${task.title}"`,
  })
  return task
}

async function accessibleProjectIds(member) {
  if (isSuperAdmin(member)) {
    const { data } = await supabase.from('pm_projects').select('id')
    return (data || []).map(p => p.id)
  }
  const { data } = await supabase.from('pm_project_members').select('project_id').eq('member_id', member.id)
  return (data || []).map(m => m.project_id)
}

async function attachDependencyFlags(tasks) {
  const ids = (tasks || []).map(t => t.id)
  if (!ids.length) return tasks
  const { data: deps } = await supabase
    .from('pm_task_dependencies')
    .select('id, blocking_task_id, blocked_task_id')
    .or(`blocking_task_id.in.(${ids.join(',')}),blocked_task_id.in.(${ids.join(',')})`)
  const byId = Object.fromEntries((tasks || []).map(t => [t.id, t]))
  const extraIds = [...new Set((deps || []).flatMap(d => [d.blocking_task_id, d.blocked_task_id]).filter(id => !byId[id]))]
  if (extraIds.length) {
    const { data: extra } = await supabase.from('pm_tasks').select('id, title, completed_at, deleted_at').in('id', extraIds)
    for (const t of extra || []) byId[t.id] = t
  }
  return (tasks || []).map(t => {
    const blocking = (deps || []).filter(d => d.blocked_task_id === t.id).map(d => {
      const other = byId[d.blocking_task_id]
      return { id: d.id, task_id: d.blocking_task_id, title: other?.title || 'Task', completed_at: other?.completed_at || null }
    })
    const blocked = (deps || []).filter(d => d.blocking_task_id === t.id).map(d => {
      const other = byId[d.blocked_task_id]
      return { id: d.id, task_id: d.blocked_task_id, title: other?.title || 'Task', completed_at: other?.completed_at || null }
    })
    return {
      ...t,
      blocking,
      blocked,
      is_blocked: blocking.some(b => !b.completed_at),
    }
  })
}

async function wouldCreateCycle(blockingId, blockedId) {
  if (blockingId === blockedId) return true
  const seen = new Set([blockedId])
  let frontier = [blockedId]
  while (frontier.length) {
    const { data } = await supabase
      .from('pm_task_dependencies')
      .select('blocked_task_id')
      .in('blocking_task_id', frontier)
    const next = (data || []).map(d => d.blocked_task_id).filter(id => !seen.has(id))
    if (next.includes(blockingId)) return true
    next.forEach(id => seen.add(id))
    frontier = next
  }
  return false
}

async function unresolvedBlockers(taskId) {
  const { data: deps } = await supabase
    .from('pm_task_dependencies')
    .select('blocking_task_id')
    .eq('blocked_task_id', taskId)
  const ids = (deps || []).map(d => d.blocking_task_id)
  if (!ids.length) return []
  const { data: tasks } = await supabase
    .from('pm_tasks')
    .select('id, title, completed_at, deleted_at')
    .in('id', ids)
    .is('deleted_at', null)
  return (tasks || []).filter(t => !t.completed_at)
}

/** Default columns created with every new board */
const DEFAULT_COLUMNS = [
  { name: 'To Do',       color: '#94a3b8', position: 0 },
  { name: 'In Progress', color: '#3b82f6', position: 1 },
  { name: 'Review',      color: '#f59e0b', position: 2 },
  { name: 'Done',        color: '#22c55e', position: 3 },
]

// ─── Projects ─────────────────────────────────────────────────────────────────

/** POST /pm/projects — create a new project */
router.post('/projects', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No organization membership found' })

    const {
      title, description, type = 'general',
      buyer_org_id, merchant_org_id, supplier_org_id, buyer_supplier_link_id,
      due_date, color = '#4d68f0', emoji = '📋',
    } = req.body

    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })

    // Create project
    const { data: project, error: projErr } = await supabase
      .from('pm_projects')
      .insert({
        title: title.trim(),
        description: description?.trim() || null,
        type,
        buyer_org_id: buyer_org_id || null,
        merchant_org_id: merchant_org_id || (member.organizations?.type === 'merchant' ? member.organizations.id : null),
        supplier_org_id: supplier_org_id || null,
        buyer_supplier_link_id: buyer_supplier_link_id || null,
        created_by_member_id: member.id,
        due_date: due_date || null,
        color,
        emoji,
      })
      .select()
      .single()

    if (projErr) throw projErr

    // Add creator as owner member
    await supabase.from('pm_project_members').insert({
      project_id: project.id,
      member_id: member.id,
      role: 'owner',
      invited_by_member_id: member.id,
    })

    // Create default board
    const { data: board, error: boardErr } = await supabase
      .from('pm_boards')
      .insert({ project_id: project.id, name: 'Main Board', position: 0 })
      .select()
      .single()

    if (boardErr) throw boardErr

    // Create default columns
    const colInserts = DEFAULT_COLUMNS.map(c => ({
      ...c,
      board_id: board.id,
      project_id: project.id,
    }))
    const { data: columns, error: colErr } = await supabase
      .from('pm_columns')
      .insert(colInserts)
      .select()

    if (colErr) throw colErr

    await logActivity(project.id, null, member.id, 'project_created', { title: project.title })

    return res.status(201).json({ project, board, columns })
  } catch (err) {
    console.error('POST /pm/projects:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/** GET /pm/projects — list projects accessible to caller */
router.get('/projects', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No organization membership found' })

    let projectIds

    if (isSuperAdmin(member)) {
      // Super admin: all active projects
      const { data: all } = await supabase
        .from('pm_projects')
        .select('id')
        .neq('status', 'archived')
      projectIds = (all || []).map(p => p.id)
    } else {
      const { data: memberships } = await supabase
        .from('pm_project_members')
        .select('project_id')
        .eq('member_id', member.id)
      projectIds = (memberships || []).map(m => m.project_id)
    }

    if (!projectIds.length) return res.json([])

    const { data: projects, error } = await supabase
      .from('pm_projects')
      .select('*')
      .in('id', projectIds)
      .neq('status', 'archived')
      .order('created_at', { ascending: false })

    if (error) throw error

    // Attach task counts and member counts
    const counts = await Promise.all(
      projects.map(async p => {
        const [{ count: total }, { count: open }, { count: memberCount }] = await Promise.all([
          supabase.from('pm_tasks').select('*', { count: 'exact', head: true }).eq('project_id', p.id).is('deleted_at', null),
          supabase.from('pm_tasks').select('*', { count: 'exact', head: true }).eq('project_id', p.id).is('deleted_at', null).is('completed_at', null),
          supabase.from('pm_project_members').select('*', { count: 'exact', head: true }).eq('project_id', p.id),
        ])
        return { id: p.id, task_count: total || 0, open_task_count: open || 0, member_count: memberCount || 0 }
      })
    )

    const countMap = Object.fromEntries(counts.map(c => [c.id, c]))
    const enriched = projects.map(p => ({ ...p, ...countMap[p.id] }))

    return res.json(enriched)
  } catch (err) {
    console.error('GET /pm/projects:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/** GET /pm/projects/:id — get project with board, columns, tasks, assignees */
router.get('/projects/:id', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No organization membership found' })

    const { id } = req.params
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(id, member.id)
    if (!pmRole) return res.status(403).json({ error: 'Access denied' })

    const [{ data: project }, { data: boards }, { data: projectMembers }] = await Promise.all([
      supabase.from('pm_projects').select('*').eq('id', id).single(),
      supabase.from('pm_boards').select('*').eq('project_id', id).order('position'),
      supabase.from('pm_project_members').select('*, organization_members(id, full_name, email)').eq('project_id', id),
    ])

    if (!project) return res.status(404).json({ error: 'Project not found' })

    const boardIds = (boards || []).map(b => b.id)
    let columns = []
    let tasks = []
    let assignees = []
    let checklists = []

    if (boardIds.length) {
      const colRes = await supabase.from('pm_columns').select('*').in('board_id', boardIds).order('position')
      const taskRes = await supabase.from('pm_tasks').select('*').in('board_id', boardIds).is('deleted_at', null).order('position')
      columns = colRes.data || []
      tasks = taskRes.data || []
      const taskIds = tasks.map(t => t.id)
      if (taskIds.length) {
        const [assigneeRes, checklistRes] = await Promise.all([
          supabase.from('pm_task_assignees').select('*, organization_members(id, full_name, email)').in('task_id', taskIds),
          supabase.from('pm_checklists').select('id, task_id, checked').in('task_id', taskIds),
        ])
        assignees = assigneeRes.data || []
        checklists = checklistRes.data || []
      }
    }

    // Attach assignees and checklist counts to tasks
    const assigneesByTask = {}
    for (const a of (assignees || [])) {
      if (!assigneesByTask[a.task_id]) assigneesByTask[a.task_id] = []
      assigneesByTask[a.task_id].push(a)
    }
    const checklistByTask = {}
    for (const c of (checklists || [])) {
      if (!checklistByTask[c.task_id]) checklistByTask[c.task_id] = { total: 0, done: 0 }
      checklistByTask[c.task_id].total++
      if (c.checked) checklistByTask[c.task_id].done++
    }

    const enrichedTasks = await attachDependencyFlags((tasks || []).map(t => ({
      ...t,
      assignees: assigneesByTask[t.id] || [],
      checklist_total: checklistByTask[t.id]?.total || 0,
      checklist_done:  checklistByTask[t.id]?.done  || 0,
    })))

    // Group tasks by column
    const tasksByColumn = {}
    for (const t of enrichedTasks) {
      if (!tasksByColumn[t.column_id]) tasksByColumn[t.column_id] = []
      tasksByColumn[t.column_id].push(t)
    }

    // Nest tasks into columns, columns into boards
    const enrichedColumns = (columns || []).map(c => ({
      ...c,
      tasks: (tasksByColumn[c.id] || []).sort((a, b) => a.position - b.position),
    }))
    const colsByBoard = {}
    for (const c of enrichedColumns) {
      if (!colsByBoard[c.board_id]) colsByBoard[c.board_id] = []
      colsByBoard[c.board_id].push(c)
    }
    const enrichedBoards = (boards || []).map(b => ({
      ...b,
      columns: (colsByBoard[b.id] || []).sort((a, b) => a.position - b.position),
    }))

    return res.json({ project, boards: enrichedBoards, members: projectMembers || [] })
  } catch (err) {
    console.error('GET /pm/projects/:id:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/** PATCH /pm/projects/:id — update project metadata */
router.patch('/projects/:id', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No organization membership found' })

    const { id } = req.params
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') {
      return res.status(403).json({ error: 'Access denied' })
    }

    const allowed = ['title', 'description', 'due_date', 'status', 'color', 'emoji', 'type']
    const updates = {}
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key]
    }
    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('pm_projects')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    await logActivity(id, null, member.id, 'project_updated', updates)
    return res.json(data)
  } catch (err) {
    console.error('PATCH /pm/projects/:id:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/** DELETE /pm/projects/:id — archive (soft delete) */
router.delete('/projects/:id', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No organization membership found' })

    const { id } = req.params
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(id, member.id)
    if (pmRole !== 'owner' && pmRole !== 'super_admin') {
      return res.status(403).json({ error: 'Only project owners can archive' })
    }

    await supabase.from('pm_projects').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', id)
    return res.json({ success: true })
  } catch (err) {
    console.error('DELETE /pm/projects/:id:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ─── Project Members ──────────────────────────────────────────────────────────

/** GET /pm/projects/:id/members */
router.get('/projects/:id/members', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (!pmRole) return res.status(403).json({ error: 'Access denied' })

    const { data, error } = await supabase
      .from('pm_project_members')
      .select('*, organization_members(id, full_name, email, department, role)')
      .eq('project_id', req.params.id)

    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** POST /pm/projects/:id/members — invite by member_id */
router.post('/projects/:id/members', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter' || pmRole === 'editor') {
      return res.status(403).json({ error: 'Only project owners can invite members' })
    }

    const { member_id, role = 'editor' } = req.body
    if (!member_id) return res.status(400).json({ error: 'member_id required' })

    const { data, error } = await supabase
      .from('pm_project_members')
      .upsert({ project_id: req.params.id, member_id, role, invited_by_member_id: member.id }, { onConflict: 'project_id,member_id' })
      .select()
      .single()

    if (error) throw error
    await logActivity(req.params.id, null, member.id, 'member_invited', { member_id, role })
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** PATCH /pm/projects/:id/members/:mid — change role */
router.patch('/projects/:id/members/:mid', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (pmRole !== 'owner' && pmRole !== 'super_admin') {
      return res.status(403).json({ error: 'Only owners can change roles' })
    }

    const { role } = req.body
    const { data, error } = await supabase
      .from('pm_project_members')
      .update({ role })
      .eq('project_id', req.params.id)
      .eq('member_id', req.params.mid)
      .select()
      .single()

    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** DELETE /pm/projects/:id/members/:mid — remove member */
router.delete('/projects/:id/members/:mid', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    // Allow removing yourself, or owner/super_admin can remove anyone
    const isSelf = req.params.mid === member.id
    if (!isSelf && pmRole !== 'owner' && pmRole !== 'super_admin') {
      return res.status(403).json({ error: 'Only owners can remove members' })
    }

    await supabase.from('pm_project_members').delete().eq('project_id', req.params.id).eq('member_id', req.params.mid)
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Boards ───────────────────────────────────────────────────────────────────

/** POST /pm/projects/:id/boards — create additional board */
router.post('/projects/:id/boards', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') {
      return res.status(403).json({ error: 'Access denied' })
    }

    const { name = 'New Board' } = req.body
    const { data: board, error: bErr } = await supabase
      .from('pm_boards')
      .insert({ project_id: req.params.id, name })
      .select()
      .single()
    if (bErr) throw bErr

    const colInserts = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id, project_id: req.params.id }))
    const { data: columns, error: cErr } = await supabase.from('pm_columns').insert(colInserts).select()
    if (cErr) throw cErr

    return res.status(201).json({ board, columns })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** PATCH /pm/boards/:boardId — rename */
router.patch('/boards/:boardId', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: board } = await supabase.from('pm_boards').select('project_id').eq('id', req.params.boardId).single()
    if (!board) return res.status(404).json({ error: 'Board not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(board.project_id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') return res.status(403).json({ error: 'Access denied' })

    const { data, error } = await supabase.from('pm_boards').update({ name: req.body.name }).eq('id', req.params.boardId).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Columns ──────────────────────────────────────────────────────────────────

/** POST /pm/boards/:boardId/columns */
router.post('/boards/:boardId/columns', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: board } = await supabase.from('pm_boards').select('project_id').eq('id', req.params.boardId).single()
    if (!board) return res.status(404).json({ error: 'Board not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(board.project_id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') return res.status(403).json({ error: 'Access denied' })

    // Put new column at the end
    const { data: last } = await supabase.from('pm_columns').select('position').eq('board_id', req.params.boardId).order('position', { ascending: false }).limit(1).maybeSingle()

    const { data, error } = await supabase
      .from('pm_columns')
      .insert({
        board_id: req.params.boardId,
        project_id: board.project_id,
        name: req.body.name || 'New Column',
        color: req.body.color || '#94a3b8',
        position: (last?.position ?? -1) + 1,
      })
      .select()
      .single()

    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** PATCH /pm/boards/:boardId/columns/:colId */
router.patch('/boards/:boardId/columns/:colId', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: board } = await supabase.from('pm_boards').select('project_id').eq('id', req.params.boardId).single()
    if (!board) return res.status(404).json({ error: 'Board not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(board.project_id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') return res.status(403).json({ error: 'Access denied' })

    const allowed = ['name', 'color', 'position', 'wip_limit']
    const updates = {}
    for (const k of allowed) if (k in req.body) updates[k] = req.body[k]

    const { data, error } = await supabase.from('pm_columns').update(updates).eq('id', req.params.colId).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** DELETE /pm/boards/:boardId/columns/:colId */
router.delete('/boards/:boardId/columns/:colId', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: board } = await supabase.from('pm_boards').select('project_id').eq('id', req.params.boardId).single()
    if (!board) return res.status(404).json({ error: 'Board not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(board.project_id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') return res.status(403).json({ error: 'Access denied' })

    const { count } = await supabase.from('pm_tasks').select('*', { count: 'exact', head: true }).eq('column_id', req.params.colId).is('deleted_at', null)
    if (count > 0 && !req.query.force) {
      return res.status(409).json({ error: `Column has ${count} task(s). Move them first, or pass ?force=true to delete anyway.` })
    }

    await supabase.from('pm_columns').delete().eq('id', req.params.colId)
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Tasks ────────────────────────────────────────────────────────────────────

/** POST /pm/columns/:colId/tasks — create task */
router.post('/columns/:colId/tasks', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: col } = await supabase.from('pm_columns').select('project_id, board_id').eq('id', req.params.colId).single()
    if (!col) return res.status(404).json({ error: 'Column not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(col.project_id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') return res.status(403).json({ error: 'Access denied' })

    // Put new task at the end of the column
    const { data: last } = await supabase
      .from('pm_tasks')
      .select('position')
      .eq('column_id', req.params.colId)
      .is('deleted_at', null)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle()

    const {
      title, description, priority = 'normal',
      due_date, estimate_hours, labels = [],
      linked_po_id, linked_workspace_id, linked_inspection_id, linked_pct_stage,
      assignee_ids = [],
      checklist = [],
    } = req.body

    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })

    const { data: task, error: tErr } = await supabase
      .from('pm_tasks')
      .insert({
        project_id: col.project_id,
        board_id: col.board_id,
        column_id: req.params.colId,
        title: title.trim(),
        description: description || null,
        priority,
        position: (last?.position ?? 0) + 65536,
        due_date: due_date || null,
        estimate_hours: estimate_hours || null,
        labels,
        linked_po_id: linked_po_id || null,
        linked_workspace_id: linked_workspace_id || null,
        linked_inspection_id: linked_inspection_id || null,
        linked_pct_stage: linked_pct_stage || null,
        created_by_member_id: member.id,
      })
      .select()
      .single()

    if (tErr) throw tErr

    // Add creator as assignee if not in assignee_ids
    const allAssignees = assignee_ids.includes(member.id) ? assignee_ids : [member.id, ...assignee_ids]
    if (allAssignees.length) {
      await supabase.from('pm_task_assignees').insert(
        allAssignees.map(mid => ({ task_id: task.id, member_id: mid, assigned_by_member_id: member.id }))
      )
    }

    // Add checklist items
    if (checklist.length) {
      await supabase.from('pm_checklists').insert(
        checklist.map((c, i) => ({ task_id: task.id, title: c.title || c, position: i }))
      )
    }

    await logActivity(col.project_id, task.id, member.id, 'task_created', { title: task.title, column: req.params.colId })
    await seedDefaultReminders(task, allAssignees)
    await notifyMembers({
      memberIds: allAssignees,
      actorId: member.id,
      task,
      type: 'assigned',
      title: `Assigned: ${task.title}`,
      emailType: 'PM_TASK_ASSIGNED',
      emailMessage: `You were assigned "${task.title}"`,
    })

    return res.status(201).json(task)
  } catch (err) {
    console.error('POST /pm/columns/:colId/tasks:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

/** GET /pm/projects/:id/tasks — filtered task list */
router.get('/projects/:id/tasks', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (!pmRole) return res.status(403).json({ error: 'Access denied' })

    let q = supabase.from('pm_tasks').select('*').eq('project_id', req.params.id).is('deleted_at', null)

    if (req.query.column_id) q = q.eq('column_id', req.query.column_id)
    if (req.query.priority)  q = q.eq('priority', req.query.priority)
    if (req.query.due_from)  q = q.gte('due_date', req.query.due_from)
    if (req.query.due_to)    q = q.lte('due_date', req.query.due_to)
    if (req.query.search)    q = q.ilike('title', `%${req.query.search}%`)

    const { data, error } = await q.order('position')
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** GET /pm/tasks/:id — single task with all relations */
router.get('/tasks/:id', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: task, error: tErr } = await supabase.from('pm_tasks').select('*').eq('id', req.params.id).single()
    if (tErr || !task) return res.status(404).json({ error: 'Task not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole) return res.status(403).json({ error: 'Access denied' })

    const [{ data: assignees }, { data: checklists }, { data: comments }, { data: activity }, { data: attachments }, { data: timeLogs }, { data: reminders }] = await Promise.all([
      supabase.from('pm_task_assignees').select('*, organization_members(id, full_name, email)').eq('task_id', req.params.id),
      supabase.from('pm_checklists').select('*').eq('task_id', req.params.id).order('position'),
      supabase.from('pm_comments').select('*, organization_members(id, full_name, email)').eq('task_id', req.params.id).is('deleted_at', null).order('created_at'),
      supabase.from('pm_activity_log').select('*, organization_members(id, full_name, email)').eq('task_id', req.params.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('pm_task_attachments').select('*').eq('task_id', req.params.id).order('created_at'),
      supabase.from('pm_time_logs').select('*, organization_members(id, full_name, email)').eq('task_id', req.params.id).order('logged_at', { ascending: false }),
      supabase.from('pm_task_reminders').select('*').eq('task_id', req.params.id).order('offset_minutes', { ascending: false }),
    ])

    const [withDeps] = await attachDependencyFlags([task])
    return res.json({
      ...withDeps,
      assignees: assignees || [],
      checklists: checklists || [],
      comments: comments || [],
      activity: activity || [],
      attachments: attachments || [],
      time_logs: timeLogs || [],
      reminders: reminders || [],
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** PATCH /pm/tasks/:id — update task metadata */
router.patch('/tasks/:id', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: task } = await supabase.from('pm_tasks').select('*').eq('id', req.params.id).single()
    if (!task) return res.status(404).json({ error: 'Task not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole || pmRole === 'viewer') return res.status(403).json({ error: 'Access denied' })

    const allowed = ['title', 'description', 'priority', 'due_date', 'estimate_hours', 'labels',
                     'linked_po_id', 'linked_workspace_id', 'linked_inspection_id', 'linked_pct_stage',
                     'recurrence_rule', 'completed_at']
    const updates = {}
    for (const k of allowed) if (k in req.body) updates[k] = req.body[k]
    if (updates.recurrence_rule === '' || updates.recurrence_rule === 'NONE') updates.recurrence_rule = null
    updates.updated_at = new Date().toISOString()

    const changes = {}
    if (updates.priority && updates.priority !== task.priority) changes.priority = { from: task.priority, to: updates.priority }
    if (updates.due_date !== undefined && updates.due_date !== task.due_date) changes.due_date = { from: task.due_date, to: updates.due_date }
    if (updates.title && updates.title !== task.title) changes.title = { from: task.title, to: updates.title }
    if (updates.completed_at && !task.completed_at) changes.completed = true
    if ('recurrence_rule' in updates && updates.recurrence_rule !== task.recurrence_rule) {
      changes.recurrence = { from: task.recurrence_rule, to: updates.recurrence_rule }
    }

    const { data, error } = await supabase.from('pm_tasks').update(updates).eq('id', req.params.id).select().single()
    if (error) throw error

    if (req.body.recurrence_scope === 'series' && 'recurrence_rule' in updates) {
      const parent = task.recurrence_parent_id || task.id
      await supabase.from('pm_tasks').update({
        recurrence_rule: updates.recurrence_rule,
        updated_at: updates.updated_at,
      }).or(`id.eq.${parent},recurrence_parent_id.eq.${parent}`).is('completed_at', null).is('deleted_at', null)
    }

    if (Object.keys(changes).length) {
      for (const [field, val] of Object.entries(changes)) {
        const action = field === 'completed' ? 'task_completed' : `${field}_changed`
        await logActivity(task.project_id, req.params.id, member.id, action, val === true ? {} : val)
      }
    }

    if (updates.due_date !== undefined && updates.due_date !== task.due_date) {
      await resetRemindersForDueDate(data)
    }

    if (updates.completed_at && !task.completed_at) {
      await spawnNextOccurrence(data)
    }

    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** PATCH /pm/tasks/:id/move — move to column + reposition (drag-and-drop) */
router.patch('/tasks/:id/move', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: task } = await supabase.from('pm_tasks').select('*').eq('id', req.params.id).single()
    if (!task) return res.status(404).json({ error: 'Task not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') return res.status(403).json({ error: 'Access denied' })

    const { column_id, position_before, position_after, board_id } = req.body
    const newPosition = midPos(position_before, position_after)

    const wasColumnId = task.column_id

    const updates = { column_id, position: newPosition, updated_at: new Date().toISOString() }
    if (board_id) updates.board_id = board_id

    let toCol = null
    if (column_id) {
      const { data: col } = await supabase.from('pm_columns').select('name').eq('id', column_id).maybeSingle()
      toCol = col
      if (toCol && /done/i.test(toCol.name || '') && !task.completed_at) {
        updates.completed_at = new Date().toISOString()
      }
    }

    const { data, error } = await supabase.from('pm_tasks').update(updates).eq('id', req.params.id).select().single()
    if (error) throw error

    if (column_id !== wasColumnId) {
      const { data: fromCol } = await supabase.from('pm_columns').select('name').eq('id', wasColumnId).maybeSingle()
      await logActivity(task.project_id, req.params.id, member.id, 'status_changed', { from: fromCol?.name, to: toCol?.name })
    }

    if (updates.completed_at && !task.completed_at) {
      await spawnNextOccurrence({ ...task, ...data })
    }

    const blockers = await unresolvedBlockers(req.params.id)
    return res.json({ ...data, blockers_warning: blockers })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** DELETE /pm/tasks/:id — soft delete */
router.delete('/tasks/:id', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: task } = await supabase.from('pm_tasks').select('project_id').eq('id', req.params.id).single()
    if (!task) return res.status(404).json({ error: 'Task not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') return res.status(403).json({ error: 'Access denied' })

    await supabase.from('pm_tasks').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id)
    await logActivity(task.project_id, req.params.id, member.id, 'task_deleted', {})
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Assignees ────────────────────────────────────────────────────────────────

/** POST /pm/tasks/:id/assignees */
router.post('/tasks/:id/assignees', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: task } = await supabase.from('pm_tasks').select('project_id').eq('id', req.params.id).single()
    if (!task) return res.status(404).json({ error: 'Task not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole || pmRole === 'viewer') return res.status(403).json({ error: 'Access denied' })

    const { member_ids = [] } = req.body
    if (!member_ids.length) return res.status(400).json({ error: 'member_ids required' })

    const rows = member_ids.map(mid => ({ task_id: req.params.id, member_id: mid, assigned_by_member_id: member.id }))
    const { data, error } = await supabase.from('pm_task_assignees').upsert(rows, { onConflict: 'task_id,member_id' }).select()
    if (error) throw error

    for (const mid of member_ids) {
      await logActivity(task.project_id, req.params.id, member.id, 'assigned', { member_id: mid })
    }

    const { data: fullTask } = await supabase.from('pm_tasks').select('*').eq('id', req.params.id).maybeSingle()
    if (fullTask) {
      await seedDefaultReminders(fullTask, member_ids)
      await notifyMembers({
        memberIds: member_ids,
        actorId: member.id,
        task: fullTask,
        type: 'assigned',
        title: `Assigned: ${fullTask.title}`,
        emailType: 'PM_TASK_ASSIGNED',
        emailMessage: `You were assigned "${fullTask.title}"`,
      })
    }

    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** DELETE /pm/tasks/:id/assignees/:mid */
router.delete('/tasks/:id/assignees/:mid', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: task } = await supabase.from('pm_tasks').select('project_id').eq('id', req.params.id).single()
    if (!task) return res.status(404).json({ error: 'Task not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole || pmRole === 'viewer') return res.status(403).json({ error: 'Access denied' })

    await supabase.from('pm_task_assignees').delete().eq('task_id', req.params.id).eq('member_id', req.params.mid)
    await logActivity(task.project_id, req.params.id, member.id, 'unassigned', { member_id: req.params.mid })
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Checklists ───────────────────────────────────────────────────────────────

/** POST /pm/tasks/:id/checklists */
router.post('/tasks/:id/checklists', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: task } = await supabase.from('pm_tasks').select('project_id').eq('id', req.params.id).single()
    if (!task) return res.status(404).json({ error: 'Task not found' })

    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole || pmRole === 'viewer') return res.status(403).json({ error: 'Access denied' })

    const { data: last } = await supabase.from('pm_checklists').select('position').eq('task_id', req.params.id).order('position', { ascending: false }).limit(1).maybeSingle()

    const { data, error } = await supabase
      .from('pm_checklists')
      .insert({ task_id: req.params.id, title: req.body.title || 'New item', position: (last?.position ?? -1) + 1 })
      .select()
      .single()

    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** PATCH /pm/tasks/:id/checklists/:itemId */
router.patch('/tasks/:id/checklists/:itemId', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: item } = await supabase.from('pm_checklists').select('task_id').eq('id', req.params.itemId).single()
    if (!item) return res.status(404).json({ error: 'Checklist item not found' })

    const { data: task } = await supabase.from('pm_tasks').select('project_id').eq('id', item.task_id).single()
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole || pmRole === 'viewer') return res.status(403).json({ error: 'Access denied' })

    const updates = {}
    if ('title'   in req.body) updates.title   = req.body.title
    if ('checked' in req.body) updates.checked  = req.body.checked
    if ('position' in req.body) updates.position = req.body.position
    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase.from('pm_checklists').update(updates).eq('id', req.params.itemId).select().single()
    if (error) throw error

    if ('checked' in req.body) {
      await logActivity(task.project_id, item.task_id, member.id,
        req.body.checked ? 'checklist_checked' : 'checklist_unchecked', { title: data.title })
    }

    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/** DELETE /pm/tasks/:id/checklists/:itemId */
router.delete('/tasks/:id/checklists/:itemId', requireAuth, async (req, res) => {
  try {
    await supabase.from('pm_checklists').delete().eq('id', req.params.itemId)
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── My Tasks ─────────────────────────────────────────────────────────────────

/** GET /pm/my-tasks */
router.get('/my-tasks', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { data: assigned } = await supabase
      .from('pm_task_assignees')
      .select('task_id')
      .eq('member_id', member.id)

    const taskIds = (assigned || []).map(a => a.task_id)
    if (!taskIds.length) return res.json([])

    let q = supabase
      .from('pm_tasks')
      .select('*, pm_projects(id, title, color, emoji)')
      .in('id', taskIds)
      .is('deleted_at', null)
      .is('completed_at', null)

    if (req.query.priority)  q = q.eq('priority', req.query.priority)
    if (req.query.due_today) {
      const today = new Date().toISOString().split('T')[0]
      q = q.gte('due_date', today).lte('due_date', `${today}T23:59:59`)
    }
    if (req.query.overdue) {
      q = q.lt('due_date', new Date().toISOString())
    }

    const { data, error } = await q.order('due_date', { ascending: true, nullsFirst: false })
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Activity ─────────────────────────────────────────────────────────────────

/** GET /pm/tasks/:id/activity */
router.get('/tasks/:id/activity', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pm_activity_log')
      .select('*, organization_members(id, full_name, email)')
      .eq('task_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Comments ─────────────────────────────────────────────────────────────────

router.post('/tasks/:id/comments', requireAuth, upload.array('files', 8), async (req, res) => {
  const uploadedPaths = []
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    const role = await assertTaskAccess(member, task)
    if (!role) return res.status(403).json({ error: 'Access denied' })
    if (role === 'viewer') return res.status(403).json({ error: 'Viewers cannot comment' })

    const rawBody = req.body.body || ''
    const format = req.body.format || 'html'
    const sanitized = format === 'html' ? sanitizeRichComment(rawBody) : rawBody
    const mentions = parseMentionIds(sanitized, JSON.parse(req.body.mentions || '[]'))
    if (!sanitized.trim() && !(req.files || []).length) {
      return res.status(400).json({ error: 'Comment body or attachments required' })
    }

    const attachments = []
    for (const file of req.files || []) {
      const safeName = (file.originalname || 'file').replace(/\s+/g, '_')
      const storagePath = `${PM_PREFIX}/tasks/${task.id}/comments/${Date.now()}_${safeName}`
      const { error: upErr } = await supabase.storage
        .from(PM_BUCKET).upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false })
      if (upErr) throw upErr
      uploadedPaths.push(storagePath)
      const { data: urlData } = supabase.storage.from(PM_BUCKET).getPublicUrl(storagePath)
      attachments.push({ url: urlData.publicUrl, name: file.originalname, type: file.mimetype, path: storagePath })
    }

    const { data: comment, error } = await supabase.from('pm_comments').insert({
      task_id: task.id,
      author_member_id: member.id,
      body: sanitized.trim() || '',
      attachments,
      mentions,
    }).select('*, organization_members(id, full_name, email)').single()
    if (error) throw error

    await logActivity(task.project_id, task.id, member.id, 'commented', {})
    const { data: actor } = await supabase.from('organization_members').select('full_name').eq('id', member.id).maybeSingle()
    await notifyMembers({
      memberIds: mentions,
      actorId: member.id,
      task,
      type: 'mentioned',
      title: `${actor?.full_name || 'Someone'} mentioned you`,
      emailType: 'PM_MENTIONED',
      emailMessage: sanitized.replace(/<[^>]+>/g, ' ').slice(0, 240),
    })

    return res.status(201).json(comment)
  } catch (err) {
    if (uploadedPaths.length) await supabase.storage.from(PM_BUCKET).remove(uploadedPaths)
    console.error('POST /pm/tasks/:id/comments:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

router.patch('/tasks/:id/comments/:cid', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    const role = await assertTaskAccess(member, task)
    if (!role) return res.status(403).json({ error: 'Access denied' })

    const { data: existing } = await supabase.from('pm_comments').select('*').eq('id', req.params.cid).maybeSingle()
    if (!existing) return res.status(404).json({ error: 'Comment not found' })
    if (existing.author_member_id !== member.id && role !== 'super_admin' && role !== 'owner') {
      return res.status(403).json({ error: 'You can only edit your own comments' })
    }

    const sanitized = sanitizeRichComment(req.body.body || '')
    const mentions = parseMentionIds(sanitized, req.body.mentions || [])
    const { data, error } = await supabase.from('pm_comments').update({
      body: sanitized,
      mentions,
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.cid).select('*, organization_members(id, full_name, email)').single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.delete('/tasks/:id/comments/:cid', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    const role = await assertTaskAccess(member, task)
    if (!role) return res.status(403).json({ error: 'Access denied' })

    const { data: existing } = await supabase.from('pm_comments').select('*').eq('id', req.params.cid).maybeSingle()
    if (!existing) return res.status(404).json({ error: 'Comment not found' })
    if (existing.author_member_id !== member.id && role !== 'super_admin' && role !== 'owner') {
      return res.status(403).json({ error: 'You can only delete your own comments' })
    }

    await supabase.from('pm_comments').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.cid)
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/tasks/:id/inline-image', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' })
    if (!req.file.mimetype?.startsWith('image/')) return res.status(400).json({ error: 'image files only' })
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    if (!(await assertTaskAccess(member, task))) return res.status(403).json({ error: 'Access denied' })

    const safeName = (req.file.originalname || 'image').replace(/\s+/g, '_')
    const storagePath = `${PM_PREFIX}/tasks/${task.id}/inline/${Date.now()}_${safeName}`
    const { error: upErr } = await supabase.storage
      .from(PM_BUCKET).upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false })
    if (upErr) throw upErr
    const { data: urlData } = supabase.storage.from(PM_BUCKET).getPublicUrl(storagePath)
    return res.json({ url: urlData.publicUrl, path: storagePath })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Attachments ──────────────────────────────────────────────────────────────

router.post('/tasks/:id/attachments', requireAuth, upload.array('files', 10), async (req, res) => {
  const uploadedPaths = []
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    const role = await assertTaskAccess(member, task, true)
    if (!role || role === 'commenter') return res.status(403).json({ error: 'Access denied' })
    if (!(req.files || []).length) return res.status(400).json({ error: 'files required' })

    const rows = []
    for (const file of req.files) {
      const safeName = (file.originalname || 'file').replace(/\s+/g, '_')
      const storagePath = `${PM_PREFIX}/tasks/${task.id}/files/${Date.now()}_${safeName}`
      const { error: upErr } = await supabase.storage
        .from(PM_BUCKET).upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false })
      if (upErr) throw upErr
      uploadedPaths.push(storagePath)
      const { data: urlData } = supabase.storage.from(PM_BUCKET).getPublicUrl(storagePath)
      rows.push({
        task_id: task.id,
        uploader_member_id: member.id,
        file_name: file.originalname,
        file_url: urlData.publicUrl,
        storage_path: storagePath,
        file_size: file.size,
        mime_type: file.mimetype,
      })
    }

    const { data, error } = await supabase.from('pm_task_attachments').insert(rows).select()
    if (error) throw error
    await logActivity(task.project_id, task.id, member.id, 'attachment_added', { count: rows.length })
    return res.status(201).json(data)
  } catch (err) {
    if (uploadedPaths.length) await supabase.storage.from(PM_BUCKET).remove(uploadedPaths)
    return res.status(500).json({ error: err.message })
  }
})

router.delete('/tasks/:id/attachments/:attId', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    const role = await assertTaskAccess(member, task, true)
    if (!role || role === 'commenter') return res.status(403).json({ error: 'Access denied' })

    const { data: att } = await supabase.from('pm_task_attachments').select('*').eq('id', req.params.attId).maybeSingle()
    if (!att) return res.status(404).json({ error: 'Attachment not found' })
    if (att.storage_path?.startsWith(`${PM_PREFIX}/tasks/${task.id}/`)) {
      await supabase.storage.from(PM_BUCKET).remove([att.storage_path])
    }
    await supabase.from('pm_task_attachments').delete().eq('id', att.id)
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Time logs ────────────────────────────────────────────────────────────────

router.get('/tasks/:id/time-logs', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    if (!(await assertTaskAccess(member, task))) return res.status(403).json({ error: 'Access denied' })
    const { data, error } = await supabase
      .from('pm_time_logs')
      .select('*, organization_members(id, full_name, email)')
      .eq('task_id', req.params.id)
      .order('logged_at', { ascending: false })
    if (error) throw error
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/tasks/:id/time-logs', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    const role = await assertTaskAccess(member, task, true)
    if (!role || role === 'commenter') return res.status(403).json({ error: 'Access denied' })

    const hours = parseFloat(req.body.logged_hours)
    if (!hours || hours <= 0) return res.status(400).json({ error: 'logged_hours must be > 0' })

    const { data, error } = await supabase.from('pm_time_logs').insert({
      task_id: task.id,
      member_id: member.id,
      logged_hours: hours,
      note: req.body.note || null,
      logged_at: req.body.logged_at || new Date().toISOString().slice(0, 10),
    }).select('*, organization_members(id, full_name, email)').single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.delete('/tasks/:id/time-logs/:logId', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    const role = await assertTaskAccess(member, task, true)
    if (!role) return res.status(403).json({ error: 'Access denied' })
    await supabase.from('pm_time_logs').delete().eq('id', req.params.logId).eq('task_id', task.id)
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Reminders ────────────────────────────────────────────────────────────────

router.get('/tasks/:id/reminders', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    if (!(await assertTaskAccess(member, task))) return res.status(403).json({ error: 'Access denied' })
    const { data } = await supabase.from('pm_task_reminders').select('*').eq('task_id', task.id).order('offset_minutes', { ascending: false })
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/tasks/:id/reminders', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    const role = await assertTaskAccess(member, task, true)
    if (!role || role === 'commenter') return res.status(403).json({ error: 'Access denied' })
    const offset = parseInt(req.body.offset_minutes, 10)
    if (!offset || offset <= 0) return res.status(400).json({ error: 'offset_minutes required' })
    const { data, error } = await supabase.from('pm_task_reminders').upsert({
      task_id: task.id,
      member_id: req.body.member_id || member.id,
      offset_minutes: offset,
      channel: req.body.channel || 'both',
    }, { onConflict: 'task_id,member_id,offset_minutes' }).select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.delete('/tasks/:id/reminders/:rid', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    const task = await loadTask(req.params.id)
    if (!(await assertTaskAccess(member, task, true))) return res.status(403).json({ error: 'Access denied' })
    await supabase.from('pm_task_reminders').delete().eq('id', req.params.rid).eq('task_id', task.id)
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Notifications ────────────────────────────────────────────────────────────

router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    let q = supabase.from('pm_notifications').select('*').eq('member_id', member.id).order('created_at', { ascending: false }).limit(50)
    if (req.query.unread === 'true') q = q.eq('read', false)
    const { data, error } = await q
    if (error) throw error
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.patch('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const { data, error } = await supabase
      .from('pm_notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('member_id', member.id)
      .select()
      .single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/notifications/read-all', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    await supabase.from('pm_notifications').update({ read: true }).eq('member_id', member.id).eq('read', false)
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.patch('/notifications/:id/snooze', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const minutes = parseInt(req.body.minutes, 10) || 10
    const until = new Date(Date.now() + minutes * 60000).toISOString()
    const { data, error } = await supabase
      .from('pm_notifications')
      .update({ snoozed_until: until })
      .eq('id', req.params.id)
      .eq('member_id', member.id)
      .select()
      .single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.get('/notification-preferences', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const { data } = await supabase.from('pm_notification_preferences').select('*').eq('member_id', member.id).maybeSingle()
    return res.json(data || { member_id: member.id, preferences: {} })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.patch('/notification-preferences', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const { data, error } = await supabase.from('pm_notification_preferences').upsert({
      member_id: member.id,
      preferences: req.body.preferences || {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'member_id' }).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Saved filters (Phase 5) ──────────────────────────────────────────────────

router.get('/projects/:id/saved-filters', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (!pmRole) return res.status(403).json({ error: 'Access denied' })

    const { data, error } = await supabase
      .from('pm_saved_filters')
      .select('*')
      .eq('project_id', req.params.id)
      .or(`member_id.eq.${member.id},member_id.is.null`)
      .order('created_at', { ascending: false })
    if (error) throw error
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/projects/:id/saved-filters', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (!pmRole || pmRole === 'viewer') return res.status(403).json({ error: 'Access denied' })

    const name = String(req.body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Name is required' })

    const { data, error } = await supabase
      .from('pm_saved_filters')
      .insert({
        project_id: req.params.id,
        member_id: member.id,
        name,
        filters: req.body.filters || {},
      })
      .select()
      .single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.delete('/projects/:id/saved-filters/:fid', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (!pmRole || pmRole === 'viewer') return res.status(403).json({ error: 'Access denied' })

    const { data: row } = await supabase
      .from('pm_saved_filters')
      .select('id, member_id')
      .eq('id', req.params.fid)
      .eq('project_id', req.params.id)
      .maybeSingle()
    if (!row) return res.status(404).json({ error: 'Filter not found' })
    if (row.member_id && row.member_id !== member.id && !isSuperAdmin(member)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    await supabase.from('pm_saved_filters').delete().eq('id', req.params.fid)
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Search + live links (Phase 6) ────────────────────────────────────────────

router.get('/search/pos', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const q = safeSearch(req.query.q)
    const orgId = memberOrgId(member)

    let linkIds = null
    if (orgId) {
      const { data: links } = await supabase
        .from('buyer_supplier_links')
        .select('id')
        .or(`buyer_org_id.eq.${orgId},supplier_org_id.eq.${orgId}`)
      linkIds = (links || []).map(l => l.id)
      if (!linkIds.length) return res.json([])
    }

    let query = supabase
      .from('purchase_orders')
      .select('id, po_number, ex_factory_date, status, buyer_supplier_links(buyer:organizations!buyer_supplier_links_buyer_org_id_fkey(display_name), supplier:organizations!buyer_supplier_links_supplier_org_id_fkey(display_name))')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(20)
    if (linkIds) query = query.in('buyer_supplier_link_id', linkIds)
    if (q) query = query.ilike('po_number', `%${q}%`)

    const { data, error } = await query
    if (error) throw error
    return res.json((data || []).map(po => ({
      id: po.id,
      po_number: po.po_number,
      ex_factory_date: po.ex_factory_date,
      status: po.status,
      buyer: po.buyer_supplier_links?.buyer?.display_name || null,
      supplier: po.buyer_supplier_links?.supplier?.display_name || null,
    })))
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.get('/search/workspaces', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const q = safeSearch(req.query.q)
    const orgId = memberOrgId(member)

    let query = supabase
      .from('npd2_workspaces')
      .select('id, buyer_ref, status, buyer_org_id, supplier_org_id, catalog_sku_id')
      .order('created_at', { ascending: false })
      .limit(20)
    if (orgId) query = query.or(`buyer_org_id.eq.${orgId},supplier_org_id.eq.${orgId}`)
    if (q) query = query.ilike('buyer_ref', `%${q}%`)

    const { data, error } = await query
    if (error) throw error

    const skuIds = [...new Set((data || []).map(w => w.catalog_sku_id).filter(Boolean))]
    let skuMap = {}
    if (skuIds.length) {
      const { data: skus } = await supabase.from('skus').select('id, auto_code, buyer_sku_ref').in('id', skuIds)
      skuMap = Object.fromEntries((skus || []).map(s => [s.id, s]))
    }

    return res.json((data || []).map(w => ({
      id: w.id,
      buyer_ref: w.buyer_ref,
      status: w.status,
      sku_code: skuMap[w.catalog_sku_id]?.auto_code || skuMap[w.catalog_sku_id]?.buyer_sku_ref || null,
    })))
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.get('/search/inspections', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const q = safeSearch(req.query.q)

    let reportIds = null
    if (q && UUID_RE.test(q)) {
      reportIds = [q]
    } else if (q) {
      const { data: pos } = await supabase
        .from('purchase_orders')
        .select('id')
        .ilike('po_number', `%${q}%`)
        .is('deleted_at', null)
        .limit(20)
      const poIds = (pos || []).map(p => p.id)
      let lineQ = supabase.from('po_line_items').select('id').limit(80)
      if (poIds.length) lineQ = lineQ.or(`po_id.in.(${poIds.join(',')}),buyer_sku_ref.ilike.%${q}%`)
      else lineQ = lineQ.ilike('buyer_sku_ref', `%${q}%`)
      const { data: lines } = await lineQ
      const lineIds = (lines || []).map(l => l.id)
      if (!lineIds.length) return res.json([])
      const { data: reports } = await supabase
        .from('inspection_reports')
        .select('id')
        .in('po_line_item_id', lineIds)
        .order('created_at', { ascending: false })
        .limit(20)
      reportIds = (reports || []).map(r => r.id)
      if (!reportIds.length) return res.json([])
    }

    let query = supabase
      .from('inspection_reports')
      .select('id, inspection_type, round, status, inspection_result, po_line_item_id, po_line_items(buyer_sku_ref, purchase_orders(id, po_number))')
      .order('created_at', { ascending: false })
      .limit(20)
    if (reportIds) query = query.in('id', reportIds)

    const { data, error } = await query
    if (error) throw error
    return res.json((data || []).map(r => ({
      id: r.id,
      inspection_type: r.inspection_type,
      round: r.round,
      status: r.status,
      result: r.inspection_result,
      sku: r.po_line_items?.buyer_sku_ref || null,
      po_number: r.po_line_items?.purchase_orders?.po_number || null,
      po_id: r.po_line_items?.purchase_orders?.id || null,
    })))
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.get('/links/resolve', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })

    const { po_id, workspace_id, inspection_id } = req.query
    const out = { po: null, workspace: null, inspection: null }

    if (po_id && UUID_RE.test(po_id)) {
      const { data: po } = await supabase
        .from('purchase_orders')
        .select('id, po_number, ex_factory_date, status, buyer_supplier_links(buyer:organizations!buyer_supplier_links_buyer_org_id_fkey(display_name), supplier:organizations!buyer_supplier_links_supplier_org_id_fkey(display_name))')
        .eq('id', po_id)
        .maybeSingle()
      if (po) {
        out.po = {
          id: po.id,
          po_number: po.po_number,
          ex_factory_date: po.ex_factory_date,
          status: po.status,
          buyer: po.buyer_supplier_links?.buyer?.display_name || null,
          supplier: po.buyer_supplier_links?.supplier?.display_name || null,
        }
      }
    }

    if (workspace_id && UUID_RE.test(workspace_id)) {
      const { data: w } = await supabase
        .from('npd2_workspaces')
        .select('id, buyer_ref, status, catalog_sku_id')
        .eq('id', workspace_id)
        .maybeSingle()
      if (w) {
        let sku_code = null
        if (w.catalog_sku_id) {
          const { data: sku } = await supabase.from('skus').select('auto_code, buyer_sku_ref').eq('id', w.catalog_sku_id).maybeSingle()
          sku_code = sku?.auto_code || sku?.buyer_sku_ref || null
        }
        out.workspace = { id: w.id, buyer_ref: w.buyer_ref, status: w.status, sku_code }
      }
    }

    if (inspection_id && UUID_RE.test(inspection_id)) {
      const { data: r } = await supabase
        .from('inspection_reports')
        .select('id, inspection_type, round, status, inspection_result, po_line_items(buyer_sku_ref, purchase_orders(id, po_number))')
        .eq('id', inspection_id)
        .maybeSingle()
      if (r) {
        out.inspection = {
          id: r.id,
          inspection_type: r.inspection_type,
          round: r.round,
          status: r.status,
          result: r.inspection_result,
          sku: r.po_line_items?.buyer_sku_ref || null,
          po_number: r.po_line_items?.purchase_orders?.po_number || null,
          po_id: r.po_line_items?.purchase_orders?.id || null,
        }
      }
    }

    return res.json(out)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── Create task from source (Phase 6) ────────────────────────────────────────

async function handleCreateFromSource(req, res) {
  const member = await resolveMember(req.user.id)
  if (!member) return res.status(403).json({ error: 'No membership' })

  const {
    project_id, title, description, priority, due_date, labels,
    linked_po_id, linked_workspace_id, linked_inspection_id, linked_pct_stage,
    po_number, assignee_ids,
  } = req.body || {}

  if (!project_id) return res.status(400).json({ error: 'project_id is required' })

  const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(project_id, member.id)
  if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') {
    return res.status(403).json({ error: 'Access denied' })
  }

  const col = await firstWritableColumn(project_id)
  if (!col) return res.status(400).json({ error: 'Project has no board columns' })

  const resolvedPoId = await resolvePoId({ po_id: linked_po_id, po_number })
  const taskTitle = String(title || '').trim()
  if (!taskTitle) return res.status(400).json({ error: 'Title is required' })

  const task = await createTaskInColumn(member, col, {
    title: taskTitle,
    description,
    priority,
    due_date,
    labels,
    linked_po_id: resolvedPoId,
    linked_workspace_id: linked_workspace_id && UUID_RE.test(linked_workspace_id) ? linked_workspace_id : null,
    linked_inspection_id: linked_inspection_id && UUID_RE.test(linked_inspection_id) ? linked_inspection_id : null,
    linked_pct_stage: linked_pct_stage || null,
    assignee_ids,
  })
  return res.status(201).json(task)
}

router.post('/tasks/from-source', requireAuth, async (req, res) => {
  try {
    return await handleCreateFromSource(req, res)
  } catch (err) {
    console.error('POST /pm/tasks/from-source:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

router.get('/tasks/:id/dependencies', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const task = await loadTask(req.params.id)
    if (!await assertTaskAccess(member, task)) return res.status(403).json({ error: 'Access denied' })
    const [withDeps] = await attachDependencyFlags([task])
    return res.json({ blocking: withDeps.blocking || [], blocked: withDeps.blocked || [] })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/tasks/:id/dependencies', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const task = await loadTask(req.params.id)
    if (!task) return res.status(404).json({ error: 'Task not found' })
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') return res.status(403).json({ error: 'Access denied' })

    let blockingId = req.body.blocking_task_id || null
    let blockedId = req.body.blocked_task_id || null
    if (blockingId && !blockedId) blockedId = task.id
    if (blockedId && !blockingId) blockingId = task.id
    if (!blockingId || !blockedId) return res.status(400).json({ error: 'blocking_task_id or blocked_task_id is required' })
    if (blockingId === blockedId) return res.status(400).json({ error: 'A task cannot block itself' })

    const other = await loadTask(blockingId === task.id ? blockedId : blockingId)
    if (!other || other.project_id !== task.project_id) return res.status(400).json({ error: 'Both tasks must be in this project' })
    if (await wouldCreateCycle(blockingId, blockedId)) return res.status(400).json({ error: 'That dependency would create a cycle' })

    const { data, error } = await supabase.from('pm_task_dependencies').insert({
      blocking_task_id: blockingId,
      blocked_task_id: blockedId,
      created_by_member_id: member.id,
    }).select().single()
    if (error) {
      if (String(error.message || '').includes('duplicate') || error.code === '23505') {
        return res.status(409).json({ error: 'Dependency already exists' })
      }
      throw error
    }
    await logActivity(task.project_id, task.id, member.id, 'dependency_added', { blocking_task_id: blockingId, blocked_task_id: blockedId })
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.delete('/tasks/:id/dependencies/:depId', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const task = await loadTask(req.params.id)
    if (!task) return res.status(404).json({ error: 'Task not found' })
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(task.project_id, member.id)
    if (!pmRole || pmRole === 'viewer' || pmRole === 'commenter') return res.status(403).json({ error: 'Access denied' })

    const { data: row } = await supabase.from('pm_task_dependencies').select('id, blocking_task_id, blocked_task_id').eq('id', req.params.depId).maybeSingle()
    if (!row || (row.blocking_task_id !== task.id && row.blocked_task_id !== task.id)) {
      return res.status(404).json({ error: 'Dependency not found' })
    }
    await supabase.from('pm_task_dependencies').delete().eq('id', req.params.depId)
    await logActivity(task.project_id, task.id, member.id, 'dependency_removed', { dependency_id: req.params.depId })
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.get('/search', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const q = safeSearch(req.query.q)
    if (!q) return res.json({ projects: [], tasks: [] })
    const ids = await accessibleProjectIds(member)
    if (!ids.length) return res.json({ projects: [], tasks: [] })

    const [{ data: projects }, { data: tasks }] = await Promise.all([
      supabase.from('pm_projects').select('id, title, emoji, color, status').in('id', ids).ilike('title', `%${q}%`).limit(10),
      supabase.from('pm_tasks').select('id, title, project_id, due_date, priority, completed_at, pm_projects(title, emoji)').in('project_id', ids).is('deleted_at', null).ilike('title', `%${q}%`).limit(15),
    ])
    return res.json({ projects: projects || [], tasks: tasks || [] })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/projects/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (!pmRole || pmRole === 'viewer') return res.status(403).json({ error: 'Access denied' })

    const { data: src } = await supabase.from('pm_projects').select('*').eq('id', req.params.id).single()
    if (!src) return res.status(404).json({ error: 'Project not found' })

    const { data: project, error: pErr } = await supabase.from('pm_projects').insert({
      title: `Copy of ${src.title}`,
      description: src.description,
      type: src.type,
      status: 'active',
      buyer_org_id: src.buyer_org_id,
      merchant_org_id: src.merchant_org_id,
      supplier_org_id: src.supplier_org_id,
      buyer_supplier_link_id: src.buyer_supplier_link_id,
      created_by_member_id: member.id,
      due_date: src.due_date,
      color: src.color,
      emoji: src.emoji,
    }).select().single()
    if (pErr) throw pErr

    await supabase.from('pm_project_members').insert({ project_id: project.id, member_id: member.id, role: 'owner', invited_by_member_id: member.id })

    const { data: boards } = await supabase.from('pm_boards').select('*').eq('project_id', src.id).order('position')
    for (const board of boards || []) {
      const { data: newBoard } = await supabase.from('pm_boards').insert({
        project_id: project.id,
        name: board.name,
        position: board.position,
      }).select().single()
      const { data: cols } = await supabase.from('pm_columns').select('*').eq('board_id', board.id).order('position')
      if (cols?.length) {
        await supabase.from('pm_columns').insert(cols.map(c => ({
          board_id: newBoard.id,
          project_id: project.id,
          name: c.name,
          position: c.position,
          color: c.color,
          wip_limit: c.wip_limit,
        })))
      }
    }

    await logActivity(project.id, null, member.id, 'project_duplicated', { from: src.id })
    return res.status(201).json(project)
  } catch (err) {
    console.error('POST /pm/projects/:id/duplicate:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

router.get('/projects/:id/export.csv', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!member) return res.status(403).json({ error: 'No membership' })
    const pmRole = isSuperAdmin(member) ? 'super_admin' : await resolvePmRole(req.params.id, member.id)
    if (!pmRole) return res.status(403).json({ error: 'Access denied' })

    const { data: project } = await supabase.from('pm_projects').select('title').eq('id', req.params.id).maybeSingle()
    const { data: columns } = await supabase.from('pm_columns').select('id, name').eq('project_id', req.params.id)
    const colMap = Object.fromEntries((columns || []).map(c => [c.id, c.name]))
    const { data: tasks } = await supabase.from('pm_tasks').select('*').eq('project_id', req.params.id).is('deleted_at', null).order('position')
    const taskIds = (tasks || []).map(t => t.id)
    let assignees = []
    if (taskIds.length) {
      const { data } = await supabase.from('pm_task_assignees').select('task_id, organization_members(full_name, email)').in('task_id', taskIds)
      assignees = data || []
    }
    const namesByTask = {}
    for (const a of assignees) {
      if (!namesByTask[a.task_id]) namesByTask[a.task_id] = []
      namesByTask[a.task_id].push(a.organization_members?.full_name || a.organization_members?.email || '')
    }

    const esc = (v) => {
      const s = v == null ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = ['Title', 'Status', 'Priority', 'Due', 'Assignees', 'Labels', 'Recurrence', 'Completed']
    const rows = (tasks || []).map(t => [
      t.title,
      colMap[t.column_id] || '',
      t.priority || '',
      t.due_date || '',
      (namesByTask[t.id] || []).join('; '),
      (t.labels || []).join('; '),
      t.recurrence_rule || '',
      t.completed_at || '',
    ].map(esc).join(','))
    const csv = [header.join(','), ...rows].join('\n')
    const fname = `${(project?.title || 'project').replace(/[^a-z0-9-_]+/gi, '_')}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`)
    return res.send(csv)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.get('/admin/projects', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!isPmAdmin(member)) return res.status(403).json({ error: 'Admin only' })

    let q = supabase.from('pm_projects').select('*').order('created_at', { ascending: false }).limit(400)
    if (req.query.status && req.query.status !== 'all') q = q.eq('status', req.query.status)
    if (req.query.q) q = q.ilike('title', `%${safeSearch(req.query.q)}%`)
    const { data: projects, error } = await q
    if (error) throw error

    const orgIds = [...new Set((projects || []).flatMap(p => [p.buyer_org_id, p.merchant_org_id, p.supplier_org_id]).filter(Boolean))]
    let orgMap = {}
    if (orgIds.length) {
      const { data: orgs } = await supabase.from('organizations').select('id, display_name, type').in('id', orgIds)
      orgMap = Object.fromEntries((orgs || []).map(o => [o.id, o]))
    }

    const counts = await Promise.all((projects || []).map(async p => {
      const [{ count: total }, { count: open }] = await Promise.all([
        supabase.from('pm_tasks').select('*', { count: 'exact', head: true }).eq('project_id', p.id).is('deleted_at', null),
        supabase.from('pm_tasks').select('*', { count: 'exact', head: true }).eq('project_id', p.id).is('deleted_at', null).is('completed_at', null),
      ])
      return { id: p.id, task_count: total || 0, open_task_count: open || 0 }
    }))
    const countMap = Object.fromEntries(counts.map(c => [c.id, c]))

    return res.json((projects || []).map(p => ({
      ...p,
      ...countMap[p.id],
      buyer_name: orgMap[p.buyer_org_id]?.display_name || null,
      merchant_name: orgMap[p.merchant_org_id]?.display_name || null,
      supplier_name: orgMap[p.supplier_org_id]?.display_name || null,
    })))
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/admin/projects/archive', requireAuth, async (req, res) => {
  try {
    const member = await resolveMember(req.user.id)
    if (!isPmAdmin(member)) return res.status(403).json({ error: 'Admin only' })
    const ids = (req.body.ids || []).filter(id => UUID_RE.test(id))
    if (!ids.length) return res.status(400).json({ error: 'ids required' })
    await supabase.from('pm_projects').update({ status: 'archived', updated_at: new Date().toISOString() }).in('id', ids)
    return res.json({ ok: true, count: ids.length })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.post('/tasks/from-pct-stage', requireAuth, async (req, res) => {
  try {
    const { stage, po_number, po_id, title } = req.body || {}
    if (!stage) return res.status(400).json({ error: 'stage is required' })
    req.body = {
      ...req.body,
      linked_pct_stage: stage,
      po_number,
      linked_po_id: po_id || req.body.linked_po_id,
      title: title || `PCT: ${stage}${po_number ? ` — ${po_number}` : ''}`,
      labels: Array.isArray(req.body.labels) ? [...new Set([...req.body.labels, 'PCT', stage])] : ['PCT', stage],
    }
    return await handleCreateFromSource(req, res)
  } catch (err) {
    console.error('POST /pm/tasks/from-pct-stage:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
