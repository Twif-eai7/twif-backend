const supabase = require('../supabaseClient')

const RULES = new Set(['DAILY', 'WEEKLY', 'MONTHLY'])

function addInterval(iso, rule) {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return new Date().toISOString()
  if (rule === 'DAILY') d.setDate(d.getDate() + 1)
  else if (rule === 'WEEKLY') d.setDate(d.getDate() + 7)
  else if (rule === 'MONTHLY') d.setMonth(d.getMonth() + 1)
  return d.toISOString()
}

async function firstTodoColumn(projectId) {
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

/**
 * After a recurring task is completed, clone the next occurrence into To Do
 * with a reset checklist. Skips if an incomplete sibling already exists.
 */
async function spawnNextOccurrence(task) {
  if (!task?.id || !RULES.has(task.recurrence_rule)) return null
  if (!task.completed_at) return null

  const parentId = task.recurrence_parent_id || task.id
  if (!task.recurrence_parent_id) {
    await supabase.from('pm_tasks').update({ recurrence_parent_id: parentId }).eq('id', task.id)
  }

  const { data: existing } = await supabase
    .from('pm_tasks')
    .select('id')
    .eq('recurrence_parent_id', parentId)
    .is('deleted_at', null)
    .is('completed_at', null)
    .neq('id', task.id)
    .limit(1)
  if (existing?.length) return null

  const col = await firstTodoColumn(task.project_id)
  if (!col) return null

  const { data: last } = await supabase
    .from('pm_tasks')
    .select('position')
    .eq('column_id', col.id)
    .is('deleted_at', null)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: clone, error } = await supabase
    .from('pm_tasks')
    .insert({
      project_id: task.project_id,
      board_id: col.board_id,
      column_id: col.id,
      title: task.title,
      description: task.description || null,
      priority: task.priority || 'normal',
      labels: task.labels || [],
      estimate_hours: task.estimate_hours || null,
      linked_po_id: task.linked_po_id || null,
      linked_workspace_id: task.linked_workspace_id || null,
      linked_inspection_id: task.linked_inspection_id || null,
      linked_pct_stage: task.linked_pct_stage || null,
      recurrence_rule: task.recurrence_rule,
      recurrence_parent_id: parentId,
      due_date: addInterval(task.due_date, task.recurrence_rule),
      created_by_member_id: task.created_by_member_id || null,
      position: (last?.position ?? 0) + 65536,
    })
    .select()
    .single()
  if (error || !clone) return null

  const { data: assignees } = await supabase.from('pm_task_assignees').select('member_id').eq('task_id', task.id)
  if (assignees?.length) {
    await supabase.from('pm_task_assignees').insert(
      assignees.map(a => ({ task_id: clone.id, member_id: a.member_id, assigned_by_member_id: task.created_by_member_id || null }))
    )
  }

  const { data: checks } = await supabase.from('pm_checklists').select('title, position').eq('task_id', task.id).order('position')
  if (checks?.length) {
    await supabase.from('pm_checklists').insert(
      checks.map(c => ({ task_id: clone.id, title: c.title, position: c.position, checked: false }))
    )
  }

  if (clone.due_date && assignees?.length) {
    const rows = []
    for (const a of assignees) {
      for (const offset of [1440, 120, 30]) {
        rows.push({
          task_id: clone.id,
          member_id: a.member_id,
          offset_minutes: offset,
          channel: offset === 30 ? 'inapp' : 'both',
        })
      }
    }
    await supabase.from('pm_task_reminders').upsert(rows, { onConflict: 'task_id,member_id,offset_minutes', ignoreDuplicates: true })
  }

  return clone
}

async function spawnCompletedRecurring(limit = 80) {
  const { data } = await supabase
    .from('pm_tasks')
    .select('*')
    .not('recurrence_rule', 'is', null)
    .not('completed_at', 'is', null)
    .is('deleted_at', null)
    .order('completed_at', { ascending: false })
    .limit(limit)
  let spawned = 0
  for (const task of data || []) {
    const next = await spawnNextOccurrence(task)
    if (next) spawned++
  }
  return spawned
}

module.exports = { spawnNextOccurrence, spawnCompletedRecurring, addInterval }
