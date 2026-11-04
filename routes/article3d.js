const express = require('express')
const rateLimit = require('express-rate-limit')
const multer = require('multer')
const { requireAuth } = require('../middleware/auth')
const { createJob, getJob, readModel } = require('../service/article3dService')

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true)
    else cb(new Error('Use a JPG, PNG, or WebP photo.'))
  },
})

const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many 3D generations. Wait a few minutes and try again.',
    })
  },
})

function runUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next()
    const tooBig = err.code === 'LIMIT_FILE_SIZE'
    res.status(400).json({
      error: tooBig ? 'This photo is over 25 MB. Choose a smaller file.' : err.message,
    })
  })
}

router.post('/jobs', requireAuth, createLimiter, runUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' })
    const job = await createJob(req.user.id, req.file.buffer)
    res.status(202).json(job)
  } catch (err) {
    console.error('article 3d create failed:', err.message)
    const status = err.status || 500
    res.status(status).json({
      error: status === 500 ? 'Could not start 3D generation.' : err.message,
    })
  }
})

router.get('/jobs/:id', requireAuth, async (req, res) => {
  try {
    const job = await getJob(req.user.id, req.params.id)
    if (!job) return res.status(404).json({ error: 'Job not found.' })
    res.json(job)
  } catch (err) {
    console.error('article 3d status failed:', err.message)
    const status = err.status || 500
    res.status(status).json({
      error: status === 500 ? 'Could not check 3D generation.' : err.message,
    })
  }
})

router.get('/jobs/:id/model', requireAuth, async (req, res) => {
  try {
    const bytes = await readModel(req.user.id, req.params.id)
    if (!bytes) return res.status(404).json({ error: 'Job not found.' })
    res.setHeader('Content-Type', 'model/gltf-binary')
    res.send(bytes)
  } catch (err) {
    console.error('article 3d download failed:', err.message)
    const status = err.status || 500
    res.status(status).json({
      error: status === 500 ? 'Could not load the 3D model.' : err.message,
    })
  }
})

module.exports = router
