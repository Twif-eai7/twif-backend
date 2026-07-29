const express = require('express')
const multer = require('multer')
const router = express.Router()
const { requireAuth } = require('../middleware/auth')
const { resolveMember } = require('../helpers/members')
const pctService = require('../service/pctService')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error('Invalid file type'))
  },
})

function handlePctError(res, err) {
  const status = err.status || 500
  return res.status(status).json({
    error: err.message || 'Internal error',
    code: err.code || 'PCT_ERROR',
    details: err.details || {},
  })
}

async function resolveMemberWithOrg(req, res) {
  const member = await resolveMember(req, res, 'id, full_name, role, organization_id, organizations(type)')
  return member
}

router.get('/health', requireAuth, (_req, res) => {
  res.json({ ok: true, service: 'pct' })
})

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const lines = await pctService.fetchLinesForOrg(member.organization_id, {
      buyerOrgId: req.query.buyer_org_id || null,
      limit: 500,
    })
    const rows = lines.map(pctService.mapLineToPctRow)
    const representative = pctService.representativeRowsByPO(rows)
    const kpis = pctService.computeKpis(rows)

    return res.json({ kpis, rows: representative, allLines: rows })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.get('/lines', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200)
    const lines = await pctService.fetchLinesForOrg(member.organization_id, {
      stage: req.query.stage,
      risk: req.query.risk,
      po: req.query.po,
      buyerOrgId: req.query.buyer_org_id,
      limit,
      cursor: req.query.cursor,
    })

    const mapped = lines.map(pctService.mapLineToPctRow)
    const nextCursor = lines.length === limit
      ? pctService.encodeCursor(lines[lines.length - 1].created_at, lines[lines.length - 1].id)
      : null

    return res.json({ lines: mapped, nextCursor, total: mapped.length })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.get('/lines/:id', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const line = await pctService.getLineById(req.params.id, member.organization_id)
    return res.json({ line: pctService.mapLineToPctRow(line), raw: line })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.get('/lines/:id/workflow', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    await pctService.getLineById(req.params.id, member.organization_id)
    const workflow = await pctService.loadWorkflowState(req.params.id)
    return res.json({
      stageProgress: workflow.stageProgress,
      stageChecks: workflow.stageChecks,
      stageAlertChecks: workflow.stageAlertChecks,
      inlineInspectionUploads: workflow.inlineInspectionUploads,
      line: pctService.mapLineToPctRow(workflow.line),
    })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.get('/po/:poNumber/lines', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const lines = await pctService.fetchLinesForOrg(member.organization_id, {
      po: req.params.poNumber,
      limit: 200,
    })
    return res.json({ lines: lines.map(pctService.mapLineToPctRow) })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.get('/lines/:id/activity', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    await pctService.getLineById(req.params.id, member.organization_id)
    const messages = await pctService.getActivityForLine(req.params.id)
    return res.json({ messages })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.post('/lines/:id/advance-stage', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const { stageId } = req.body
    if (!stageId) {
      return res.status(400).json({ error: 'stageId required', code: 'PCT_STAGE_BLOCKED' })
    }

    pctService.assertCanAdvanceStage(member, stageId)
    const result = await pctService.advanceStage(req.params.id, stageId, {
      memberId: member.id,
      memberName: member.full_name,
    })
    return res.json(result)
  } catch (err) {
    if (!err.code) console.log('pct_advance_blocked', { id: req.params.id, message: err.message })
    return handlePctError(res, err)
  }
})

router.patch('/lines/:id/stage-checks', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const { stageId, checkIndex, done, expectedDoneAt } = req.body
    await pctService.getLineById(req.params.id, member.organization_id)
    const row = await pctService.updateStageCheck(req.params.id, {
      stageId,
      checkIndex,
      done,
      memberName: member.full_name,
      expectedDoneAt: expectedDoneAt || null,
    })
    return res.json({ ok: true, row })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.patch('/lines/:id/alert-checks', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const { stageId, alertIndex, checkIndex, done, fileUrl, fileName, expectedDoneAt } = req.body
    await pctService.getLineById(req.params.id, member.organization_id)
    const row = await pctService.updateAlertCheck(req.params.id, {
      stageId,
      alertIndex,
      checkIndex,
      done,
      memberName: member.full_name,
      fileUrl,
      fileName,
      expectedDoneAt: expectedDoneAt || null,
    })
    return res.json({ ok: true, row })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.post('/lines/:id/uploads', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return
    if (!req.file) return res.status(400).json({ error: 'file required' })

    const stageId = req.body.stageId || null
    const alertIndex = req.body.alertIndex != null ? parseInt(req.body.alertIndex, 10) : null
    const checkIndex = req.body.checkIndex != null ? parseInt(req.body.checkIndex, 10) : null

    const result = await pctService.uploadAttachment(req.params.id, member.organization_id, {
      stageId,
      alertIndex,
      checkIndex,
      file: req.file,
      memberId: member.id,
    })
    return res.json(result)
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.post('/lines/:id/sync-plm', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const line = await pctService.getLineById(req.params.id, member.organization_id)
    const updated = await pctService.refreshPlmSnapshot(line.workspace_id)
    return res.json({ ok: true, line: updated ? pctService.mapLineToPctRow(updated) : null })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.get('/po/:poNumber/exceptions', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const checks = await pctService.getExceptionChecks(req.params.poNumber, member.organization_id)
    return res.json({ checks })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.patch('/po/:poNumber/exceptions', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const { cardIndex, pointIndex, done } = req.body
    await pctService.updateExceptionCheck(req.params.poNumber, member.organization_id, {
      cardIndex,
      pointIndex,
      done,
      memberName: member.full_name,
    })
    return res.json({ ok: true })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.get('/po/:poNumber/tab-checks/:tabKey', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const labels = req.query.labels ? JSON.parse(req.query.labels) : []
    const rows = await pctService.getTabChecks(req.params.tabKey, req.params.poNumber, member.organization_id, labels)
    return res.json({ rows })
  } catch (err) {
    return handlePctError(res, err)
  }
})

router.patch('/po/:poNumber/tab-checks/:tabKey', requireAuth, async (req, res) => {
  try {
    const member = await resolveMemberWithOrg(req, res)
    if (!member) return

    const { checkIndex, done, label } = req.body
    await pctService.updateTabCheck(req.params.tabKey, req.params.poNumber, member.organization_id, {
      checkIndex,
      done,
      memberName: member.full_name,
      label,
    })
    return res.json({ ok: true })
  } catch (err) {
    return handlePctError(res, err)
  }
})

module.exports = router
