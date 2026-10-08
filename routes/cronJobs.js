const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const { sendAlertEmail } = require('../service/emailService');


  function countBusinessDays(fromDate, toDate) {
      let count = 0;
      const cur = new Date(fromDate);
      cur.setDate(cur.getDate() + 1); // start counting from day after received
      while (cur <= toDate) {
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6) count++;
        cur.setDate(cur.getDate() + 1);
      }
      return count;
    }


      function subtractBusinessDays(date, days) {
      const result = new Date(date);
      let subtracted = 0;
      while (subtracted < days) {
        result.setDate(result.getDate() - 1);
        const dow = result.getDay();
        if (dow !== 0 && dow !== 6) subtracted++;
      }
      return result;
    }

router.post('/pi-reminder', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Normalize to IST midnight (UTC+5:30)
    const now = new Date();
    const today = new Date(now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));

    const day4Date = subtractBusinessDays(today, 4);
    const day4Str  = day4Date.toISOString().split('T')[0];

    const day5Date = subtractBusinessDays(today, 5);
    const day5Str  = day5Date.toISOString().split('T')[0];

    // ── Fetch POs received exactly on day 4 or day 5, PI not confirmed ──
    const { data: overduePOs, error: poError } = await supabase
      .from('purchase_orders')
      .select(`
        id,
        po_number,
        po_received_date,
        quantity_ordered,
        amount,
        buyer_supplier_link_id,
        buyer_supplier_links (
          buyer_org_id,
          buyer:organizations!buyer_supplier_links_buyer_org_id_fkey (display_name),
          supplier:organizations!buyer_supplier_links_supplier_org_id_fkey (display_name)
        )
      `)
      .is('pi_confirmed', null)
      .in('po_received_date', [day4Str, day5Str])
      .is('deleted_at', null)
      .is('delete_meta',null);

    if (poError) throw poError;

    console.log(`📋 Found ${overduePOs?.length || 0} POs to process`);

    if (!overduePOs || overduePOs.length === 0) {
      return res.status(200).json({ success: true, reminded: 0 });
    }

    const poIds = overduePOs.map(po => po.id);
    const buyerOrgIds = [...new Set(overduePOs.map(po => po.buyer_supplier_links?.buyer_org_id).filter(Boolean))];

    // ── Batch fetch: members for all buyer orgs ──
  // Step A: fetch all access rows (with link id)
const { data: allAccessRows, error: accessError } = await supabase
  .from('member_organization_access')
  .select('member_id, organization_id, buyer_supplier_link_id');

if (accessError) throw accessError;

// Step B: resolve link ids → buyer_org_id
const linkIds = [...new Set(
  (allAccessRows || []).map(r => r.buyer_supplier_link_id).filter(Boolean)
)];
const linkMap = {};

if (linkIds.length) {
  const { data: links } = await supabase
    .from('buyer_supplier_links')
    .select('id, buyer_org_id')
    .in('id', linkIds);

  (links || []).forEach(l => { linkMap[l.id] = l.buyer_org_id; });
}

// Step C: build buyerOrgId → member_ids map
const buyerOrgToMemberIds = {};
(allAccessRows || []).forEach(r => {
  const buyerOrgId = r.buyer_supplier_link_id
    ? linkMap[r.buyer_supplier_link_id]
    : r.organization_id;

  if (!buyerOrgId || !buyerOrgIds.includes(buyerOrgId)) return;

  if (!buyerOrgToMemberIds[buyerOrgId]) buyerOrgToMemberIds[buyerOrgId] = new Set();
  buyerOrgToMemberIds[buyerOrgId].add(r.member_id);
});

// Step D: fetch all unique member details in one query
const allMemberIds = [...new Set(Object.values(buyerOrgToMemberIds).flatMap(s => [...s]))];
const { data: allMembers } = await supabase
  .from('organization_members')
  .select('id, full_name, email, role, department')
  .in('id', allMemberIds);

const memberById = {};
(allMembers || []).forEach(m => { memberById[m.id] = m; });

// Step E: link-specific vs org-wide access maps, for recipient resolution
// (link access takes priority, org-wide access is the fallback)
const linkMemberIds = {};
const orgMemberIds = {};
(allAccessRows || []).forEach(r => {
  if (r.buyer_supplier_link_id) {
    if (!linkMemberIds[r.buyer_supplier_link_id]) linkMemberIds[r.buyer_supplier_link_id] = new Set();
    linkMemberIds[r.buyer_supplier_link_id].add(r.member_id);
  } else if (r.organization_id) {
    if (!orgMemberIds[r.organization_id]) orgMemberIds[r.organization_id] = new Set();
    orgMemberIds[r.organization_id].add(r.member_id);
  }
});

// PI_REMINDER goes only to merchandising members — never admins/owners —
// scoped to the PO's specific buyer_supplier_link_id, falling back to
// org-wide access to the buyer org when no link-specific access exists.
function resolveReminderRecipients(po, buyerOrgId) {
  let memberIds = linkMemberIds[po.buyer_supplier_link_id];
  if (!memberIds || memberIds.size === 0) memberIds = orgMemberIds[buyerOrgId];
  if (!memberIds || memberIds.size === 0) return [];

  return [...memberIds]
    .map(id => memberById[id])
    .filter(m => m && m.email && m.department === 'merchandising' && m.role !== 'admin' && m.role !== 'owner');
}

// PI_OVERDUE goes to the whole merchandising department (including the
// original reminder recipients, so they see the follow-up too) plus the
// entire tech department, any role, same link-then-org-fallback resolution.
function resolveOverdueRecipients(po, buyerOrgId) {
  let memberIds = linkMemberIds[po.buyer_supplier_link_id];
  if (!memberIds || memberIds.size === 0) memberIds = orgMemberIds[buyerOrgId];
  if (!memberIds || memberIds.size === 0) return [];

  return [...memberIds]
    .map(id => memberById[id])
    .filter(m => m && m.email && (m.department === 'merchandising' || m.department === 'tech'));
}

    // ── Batch fetch: existing PI_REMINDER / PI_OVERDUE alerts for all POs ──
    const { data: existingReminderAlerts } = await supabase
      .from('alerts')
      .select('id, po_id, alert_type')
      .in('po_id', poIds)
      .in('alert_type', ['PI_REMINDER', 'PI_OVERDUE']);

    // Build cache: { [po_id]: { PI_REMINDER: [ids], PI_OVERDUE: [ids] } }
    const alertsByPo = {};
    for (const a of existingReminderAlerts || []) {
      if (!alertsByPo[a.po_id]) alertsByPo[a.po_id] = { PI_REMINDER: [], PI_OVERDUE: [] };
      alertsByPo[a.po_id][a.alert_type]?.push(a.id);
    }

    // ── Batch fetch: PO_UPLOAD snapshots for all POs ──
    const { data: uploadAlerts } = await supabase
      .from('alerts')
      .select('po_id, po_snapshot')
      .in('po_id', poIds)
      .eq('alert_type', 'PO_UPLOAD');

    // Build cache: { [po_id]: po_snapshot }
    const snapshotByPo = {};
    for (const a of uploadAlerts || []) {
      snapshotByPo[a.po_id] = a.po_snapshot;
    }

    let totalAlertsCreated = 0;

    // memberId -> { member, pos: [...], alertIds: [...] } — PI_REMINDER and
    // PI_OVERDUE alerts are each batched into a single digest email per member
    // after the loop below, instead of one email per PO.
    const reminderDigestByMember = new Map();
    const overdueDigestByMember  = new Map();

    for (const po of overduePOs) {
      const buyerOrgId       = po.buyer_supplier_links?.buyer_org_id;
      const buyerNameText    = po.buyer_supplier_links?.buyer?.display_name    || 'Unknown Buyer';
      const supplierNameText = po.buyer_supplier_links?.supplier?.display_name || 'Unknown Supplier';

      if (!buyerOrgId) {
        console.warn(`⚠️ No buyer org for PO ${po.id} — skipping`);
        continue;
      }

    

    const daysSinceReceived = countBusinessDays(new Date(po.po_received_date), today);

      const alertType = daysSinceReceived === 4 ? 'PI_REMINDER' : 'PI_OVERDUE';

      // ── Resolve recipients from cache ──
      // PI_REMINDER: merchandising non-admin members, scoped to this PO's
      // buyer-supplier link (falling back to org-wide buyer-org access).
      // PI_OVERDUE: merchandising admins/owners plus the whole tech department,
      // same link-then-org-fallback resolution.
      const recipients = alertType === 'PI_REMINDER'
        ? resolveReminderRecipients(po, buyerOrgId)
        : resolveOverdueRecipients(po, buyerOrgId);

      if (recipients.length === 0) continue;

      // ── Skip if this PO already got this alert type ──
      const alreadySent = (alertsByPo[po.id]?.[alertType] || []).length > 0;
      if (alreadySent) {
        console.log(`ℹ️ ${alertType} already sent for PO ${po.po_number} — skipping`);
        continue;
      }

      // ── Resolve snapshot from cache ──
      const poSnapshot = snapshotByPo[po.id] || {
        po_id:            po.id,
        po_number:        po.po_number,
        buyer_name:       buyerNameText,
        supplier_name:    supplierNameText,
        po_received_date: po.po_received_date,
        quantity_ordered: po.quantity_ordered,
        amount:           po.amount,
        pi_confirmed:     false,
        pi_file_url:      null,
      };

      // ── Build alert message ──
      const alertMessage = alertType === 'PI_REMINDER'
        ? `PI confirmation due tomorrow for ${buyerNameText} → ${supplierNameText} · PO#${po.po_number}. Today is the last day to confirm.`
        : `PI confirmation overdue for ${buyerNameText} → ${supplierNameText} · PO#${po.po_number}. Please state reason for delay on dashboard.`;

      // ── Insert alerts ──
      const alertInserts = recipients.map(m => ({
        message:           alertMessage,
        alert_type:        alertType,
        po_id:             po.id,
        po_snapshot:       poSnapshot,
        recipient_user_id: m.id,
        recipient_name:    m.full_name,
        is_read:           false,
        email_sent:        false,
        retry_count:       0,
        scheduled_for:     new Date().toISOString(),
      }));

      const { data: insertedAlerts, error: alertError } = await supabase
        .from('alerts')
        .insert(alertInserts)
        .select();

      if (alertError) {
        console.error(`❌ Alert insert error for PO ${po.id}:`, alertError);
        continue;
      }

      totalAlertsCreated += insertedAlerts?.length || 0;
      console.log(`✅ ${alertType} alerts created for PO ${po.po_number}`);

      // ── Queue into each recipient's digest instead of emailing now ──
      const digestByMember = alertType === 'PI_REMINDER' ? reminderDigestByMember : overdueDigestByMember;
      const alertIdsByMember = new Map(insertedAlerts.map(a => [a.recipient_user_id, a.id]));

      for (const m of recipients) {
        if (!digestByMember.has(m.id)) {
          digestByMember.set(m.id, { member: m, pos: [], alertIds: [] });
        }
        const entry = digestByMember.get(m.id);
        entry.pos.push({
          buyer_name:    buyerNameText,
          supplier_name: supplierNameText,
          po_number:     po.po_number,
          date:          po.po_received_date,
          days_since:    daysSinceReceived,
        });
        const alertId = alertIdsByMember.get(m.id);
        if (alertId) entry.alertIds.push(alertId);
      }
    }

    // ── Flush digests: one summary email per member per alert type ──
    for (const { member, pos, alertIds } of reminderDigestByMember.values()) {
      const digestMessage = pos.length === 1
        ? `PI confirmation due tomorrow for ${pos[0].buyer_name} → ${pos[0].supplier_name} · PO#${pos[0].po_number}. Today is the last day to confirm.`
        : `${pos.length} POs need PI confirmation tomorrow — today is the last day to confirm.`;

      sendAlertEmail(
        [{ email: member.email, name: member.full_name }],
        digestMessage,
        { pos },
        'PI_REMINDER_DIGEST'
      ).then(async () => {
        if (alertIds.length === 0) return;
        const { error } = await supabase
          .from('alerts')
          .update({ email_sent: true })
          .in('id', alertIds);
        if (error) console.error('❌ Reminder digest email flag update failed:', error);
        console.log(`📧 PI_REMINDER digest sent to ${member.email} (${pos.length} POs)`);
      }).catch(err => {
        console.error(`❌ Reminder digest email failed for ${member.email}:`, err);
      });
    }

    for (const { member, pos, alertIds } of overdueDigestByMember.values()) {
      const digestMessage = pos.length === 1
        ? `PI confirmation overdue for ${pos[0].buyer_name} → ${pos[0].supplier_name} · PO#${pos[0].po_number}. Please state reason for delay on dashboard.`
        : `${pos.length} POs have overdue PI confirmations — please review on the dashboard.`;

      sendAlertEmail(
        [{ email: member.email, name: member.full_name }],
        digestMessage,
        { pos },
        'PI_OVERDUE_DIGEST'
      ).then(async () => {
        if (alertIds.length === 0) return;
        const { error } = await supabase
          .from('alerts')
          .update({ email_sent: true })
          .in('id', alertIds);
        if (error) console.error('❌ Overdue digest email flag update failed:', error);
        console.log(`📧 PI_OVERDUE digest sent to ${member.email} (${pos.length} POs)`);
      }).catch(err => {
        console.error(`❌ Overdue digest email failed for ${member.email}:`, err);
      });
    }

    return res.status(200).json({
      success:        true,
      pos_processed:  overduePOs.length,
      alerts_created: totalAlertsCreated,
    });

  } catch (err) {
    console.error('❌ PI reminder cron error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================
   POST /cron/upload-alerts-digest
   Runs once/day. PO_UPLOAD and PI_UPLOAD alerts are inserted in real time
   by the databaseWebhooks routes with email_sent=false; this sweep batches
   today's (IST) alerts into one digest email per recipient per alert type,
   instead of emailing on every single upload. Deliberately not a backlog
   processor — anything older than today, or with no resolvable recipient,
   is marked resolved without emailing rather than retried.
========================= */
router.post('/upload-alerts-digest', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    let digestsSent = 0;

    // "Today" in IST, matching the pi-reminder cron's day boundary — the
    // digest only ever covers alerts created since this run's calendar day
    // started. Nothing older is ever included or retried.
    const now = new Date();
    const todayStartIST = new Date(
      new Date(now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })).getTime() - (5.5 * 60 * 60 * 1000)
    ).toISOString();

    for (const alertType of ['PO_UPLOAD', 'PI_UPLOAD']) {
      const { data: allPending, error: fetchError } = await supabase
        .from('alerts')
        .select('id, recipient_user_id, po_snapshot, created_at')
        .eq('alert_type', alertType)
        .eq('email_sent', false);

      if (fetchError) {
        console.error(`❌ Fetch pending ${alertType} alerts error:`, fetchError);
        continue;
      }
      if (!allPending?.length) continue;

      const pendingAlerts = allPending.filter(a => a.created_at >= todayStartIST);
      const staleAlertIds = allPending.filter(a => a.created_at < todayStartIST).map(a => a.id);

      if (staleAlertIds.length > 0) {
        console.warn(`⚠️ ${staleAlertIds.length} ${alertType} alerts predate today — dropping without emailing (no backlog by design)`);
        const { error } = await supabase
          .from('alerts')
          .update({ email_sent: true })
          .in('id', staleAlertIds);
        if (error) console.error(`❌ Stale ${alertType} alert cleanup failed:`, error);
      }

      if (!pendingAlerts.length) continue;

      const memberIds = [...new Set(pendingAlerts.map(a => a.recipient_user_id))];
      const { data: members } = await supabase
        .from('organization_members')
        .select('id, full_name, email')
        .in('id', memberIds);

      const memberById = {};
      (members || []).forEach(m => { memberById[m.id] = m; });

      // recipient_user_id -> { member, pos: [...], alertIds: [...] }
      const byMember = new Map();
      const orphanedAlertIds = [];
      for (const alert of pendingAlerts) {
        const member = memberById[alert.recipient_user_id];
        if (!member?.email) {
          // Recipient no longer resolves to a real, emailable member (deleted
          // member, missing email, etc.) — mark it resolved instead of
          // leaving it to resurface on every future run forever.
          orphanedAlertIds.push(alert.id);
          continue;
        }

        if (!byMember.has(member.id)) byMember.set(member.id, { member, pos: [], alertIds: [] });
        const entry = byMember.get(member.id);
        entry.pos.push({
          po_number:     alert.po_snapshot?.po_number,
          buyer_name:    alert.po_snapshot?.buyer_name,
          supplier_name: alert.po_snapshot?.supplier_name,
          date:          alert.po_snapshot?.po_received_date,
        });
        entry.alertIds.push(alert.id);
      }

      if (orphanedAlertIds.length > 0) {
        console.warn(`⚠️ ${orphanedAlertIds.length} ${alertType} alerts have no resolvable recipient — marking sent without emailing`);
        const { error } = await supabase
          .from('alerts')
          .update({ email_sent: true })
          .in('id', orphanedAlertIds);
        if (error) console.error(`❌ Orphaned ${alertType} alert cleanup failed:`, error);
      }

      const digestType = alertType === 'PO_UPLOAD' ? 'PO_UPLOAD_DIGEST' : 'PI_UPLOAD_DIGEST';
      const noun        = alertType === 'PO_UPLOAD' ? 'POs' : 'PIs';

      for (const { member, pos, alertIds } of byMember.values()) {
        const digestMessage = pos.length === 1
          ? (alertType === 'PO_UPLOAD'
              ? `PO received for ${pos[0].buyer_name} → ${pos[0].supplier_name} · PO#${pos[0].po_number}`
              : `PI uploaded for ${pos[0].buyer_name} → ${pos[0].supplier_name} · PO#${pos[0].po_number}`)
          : `${pos.length} ${noun} uploaded today`;

        sendAlertEmail(
          [{ email: member.email, name: member.full_name }],
          digestMessage,
          { pos },
          digestType
        ).then(async () => {
          const { error } = await supabase
            .from('alerts')
            .update({ email_sent: true })
            .in('id', alertIds);
          if (error) console.error(`❌ ${digestType} email flag update failed:`, error);
          console.log(`📧 ${digestType} sent to ${member.email} (${pos.length} ${noun})`);
        }).catch(err => {
          console.error(`❌ ${digestType} email failed for ${member.email}:`, err);
        });

        digestsSent++;
      }
    }

    return res.status(200).json({ success: true, digests_sent: digestsSent });

  } catch (err) {
    console.error('❌ Upload alerts digest cron error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── PM due-date reminders (run every 5 minutes) ─────────────────────────────
router.post('/pm-task-reminders', async (req, res) => {
  const secret = req.headers['x-cron-secret']
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const now = new Date()
    const { data: pending, error } = await supabase
      .from('pm_task_reminders')
      .select('id, task_id, member_id, offset_minutes, channel, sent_at, pm_tasks(id, title, due_date, priority, project_id, deleted_at, completed_at)')
      .is('sent_at', null)
      .limit(500)
    if (error) throw error

    let sent = 0
    for (const rem of pending || []) {
      const task = rem.pm_tasks
      if (!task || task.deleted_at || task.completed_at || !task.due_date) continue
      const due = new Date(task.due_date)
      const fireAt = new Date(due.getTime() - rem.offset_minutes * 60000)
      if (fireAt > now) continue
      if (due.getTime() + 60 * 60000 < now.getTime()) {
        await supabase.from('pm_task_reminders').update({ sent_at: now.toISOString() }).eq('id', rem.id)
        continue
      }

      const { data: project } = await supabase.from('pm_projects').select('title').eq('id', task.project_id).maybeSingle()
      const { data: member } = await supabase.from('organization_members').select('id, full_name, email').eq('id', rem.member_id).maybeSingle()
      if (!member) continue

      const dueLabel = due.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      const title = rem.offset_minutes >= 1440 ? `Due tomorrow: ${task.title}` : `Due soon: ${task.title}`

      await supabase.from('pm_notifications').insert({
        member_id: member.id,
        task_id: task.id,
        project_id: task.project_id,
        type: 'reminder',
        title,
        body: `${project?.title || 'Project'} · due ${dueLabel}`,
      })

      if ((rem.channel === 'email' || rem.channel === 'both') && member.email) {
        sendAlertEmail(
          [{ email: member.email, name: member.full_name }],
          `${task.title} is due ${dueLabel}`,
          {
            task_title: task.title,
            project_title: project?.title,
            priority: task.priority,
            due_date: dueLabel,
            due_label: dueLabel,
          },
          'PM_TASK_REMINDER'
        ).catch(err => console.error('PM reminder email failed:', err.message))
      }

      await supabase.from('pm_task_reminders').update({ sent_at: now.toISOString() }).eq('id', rem.id)
      sent++
    }

    let spawned = 0
    try {
      const { spawnCompletedRecurring } = require('../service/pmRecurrence')
      spawned = await spawnCompletedRecurring(80)
    } catch (spawnErr) {
      console.error('PM recurrence spawn failed:', spawnErr.message)
    }

    return res.json({ success: true, sent, spawned })
  } catch (err) {
    console.error('POST /cron/pm-task-reminders:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── PM daily digest (run once a day ~ 8:00 IST) ─────────────────────────────
router.post('/pm-daily-digest', async (req, res) => {
  const secret = req.headers['x-cron-secret']
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    const { data: prefs } = await supabase.from('pm_notification_preferences').select('member_id, preferences')
    const digestMemberIds = (prefs || [])
      .filter(p => p.preferences?.daily_digest)
      .map(p => p.member_id)

    // Also include anyone with overdue/today tasks even if they haven't saved prefs — skip unless opted in.
    if (!digestMemberIds.length) return res.json({ success: true, sent: 0 })

    const { data: members } = await supabase
      .from('organization_members')
      .select('id, full_name, email')
      .in('id', digestMemberIds)

    let sent = 0
    for (const member of members || []) {
      if (!member.email) continue
      const { data: assigned } = await supabase
        .from('pm_task_assignees')
        .select('task_id, pm_tasks(id, title, due_date, priority, project_id, deleted_at, completed_at)')
        .eq('member_id', member.id)

      const tasks = (assigned || [])
        .map(a => a.pm_tasks)
        .filter(t => t && !t.deleted_at && !t.completed_at && t.due_date)
        .filter(t => {
          const d = new Date(t.due_date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
          return d <= today
        })

      if (!tasks.length) continue

      const projectIds = [...new Set(tasks.map(t => t.project_id))]
      const { data: projects } = await supabase.from('pm_projects').select('id, title').in('id', projectIds)
      const pmap = Object.fromEntries((projects || []).map(p => [p.id, p.title]))
      const rows = tasks.map(t => ({
        title: t.title,
        project_title: pmap[t.project_id],
        priority: t.priority,
        due_date: new Date(t.due_date).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        due_label: new Date(t.due_date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) < today ? 'Overdue' : 'Due today',
      }))

      sendAlertEmail(
        [{ email: member.email, name: member.full_name }],
        `${rows.length} task${rows.length === 1 ? '' : 's'} due today or overdue`,
        { tasks: rows },
        'PM_DAILY_DIGEST'
      ).catch(err => console.error('PM digest failed:', err.message))
      sent++
    }

    return res.json({ success: true, sent })
  } catch (err) {
    console.error('POST /cron/pm-daily-digest:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router;