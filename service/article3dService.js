const axios = require('axios')
const sharp = require('sharp')
const Replicate = require('replicate')
const supabase = require('../supabaseClient')

const BUCKET = 'article-3d'
// Community model. Call the pinned version through POST /predictions.
// firtoz/trellis returns a textured GLB in output.model_file.
const MODEL_VERSION = 'e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c'
const TEXTURE_SIZE = 2048
const MAX_JPEG_BYTES = 6 * 1024 * 1024
const MAX_MODEL_BYTES = 40 * 1024 * 1024
const SAVE_STALE_MS = 2 * 60 * 1000

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function orientedSize(meta) {
  if (!meta.width || !meta.height) return null
  if (meta.orientation >= 5) return { width: meta.height, height: meta.width }
  return { width: meta.width, height: meta.height }
}

async function prepareImage(buffer) {
  let meta
  try {
    meta = await sharp(buffer, { failOn: 'none' }).metadata()
  } catch {
    throw httpError(400, 'Use a JPG, PNG, or WebP photo.')
  }

  const size = orientedSize(meta)
  if (!size) throw httpError(400, 'Could not read that image.')
  if (size.width < 128 || size.height < 128) {
    throw httpError(400, 'Use a photo at least 128 pixels on each side.')
  }

  let out = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer()

  if (out.length > MAX_JPEG_BYTES) {
    out = await sharp(out).resize(1600, 1600, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()
  }
  if (out.length > MAX_JPEG_BYTES) {
    out = await sharp(out).resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()
  }
  if (out.length > MAX_JPEG_BYTES) {
    throw httpError(400, 'That photo is still too large after compression. Try a smaller image.')
  }
  return out
}

function mapDbError(error) {
  if (!error) return null
  if (error.code === '42P01' || /article_3d_jobs/i.test(error.message || '')) {
    return httpError(503, 'article_3d_jobs is missing. Run migrations/add_article_3d_jobs.sql in Supabase.')
  }
  return error
}

async function insertJob(userId) {
  const { data, error } = await supabase
    .from('article_3d_jobs')
    .insert({ user_id: userId, status: 'processing' })
    .select('id, status, created_at')
    .single()
  if (error) throw mapDbError(error)
  return data
}

function replicateClient() {
  if (!process.env.REPLICATE_API_TOKEN) {
    throw httpError(503, 'REPLICATE_API_TOKEN is not configured.')
  }
  return new Replicate({ auth: process.env.REPLICATE_API_TOKEN })
}

function extractModelUrl(output) {
  if (!output) return null
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.find((item) => typeof item === 'string' && item.startsWith('http')) || null
  }
  if (typeof output === 'object') {
    const candidate = output.model_file || output.mesh || output.mesh_paint || output.model || output.glb
    return typeof candidate === 'string' ? candidate : null
  }
  return null
}

function present(job) {
  return {
    id: job.id,
    status: job.status === 'saving' ? 'processing' : job.status,
    error: job.status === 'failed' ? (job.error || '3D generation failed.') : null,
    createdAt: job.created_at,
  }
}

async function loadJob(id, userId) {
  const { data, error } = await supabase
    .from('article_3d_jobs')
    .select('id, user_id, status, source_path, model_path, prediction_id, error, created_at, updated_at')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw mapDbError(error)
  return data
}

async function updateJob(id, patch) {
  const { error } = await supabase
    .from('article_3d_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw mapDbError(error)
}

async function createJob(userId, buffer) {
  if (!process.env.REPLICATE_API_TOKEN) {
    throw httpError(503, 'REPLICATE_API_TOKEN is not configured.')
  }

  const jpeg = await prepareImage(buffer)
  const job = await insertJob(userId)
  const sourcePath = `sources/${job.id}.jpg`

  try {
    const uploaded = await supabase.storage.from(BUCKET).upload(sourcePath, jpeg, {
      contentType: 'image/jpeg',
      upsert: true,
    })
    if (uploaded.error) throw uploaded.error

    const signed = await supabase.storage.from(BUCKET).createSignedUrl(sourcePath, 60 * 60)
    if (signed.error || !signed.data?.signedUrl) {
      throw signed.error || new Error('Could not prepare the image for generation.')
    }

    const prediction = await replicateClient().predictions.create({
      version: MODEL_VERSION,
      input: {
        images: [signed.data.signedUrl],
        generate_model: true,
        generate_color: false,
        generate_normal: false,
        save_gaussian_ply: false,
        texture_size: TEXTURE_SIZE,
        mesh_simplify: 0.9,
      },
    })

    if (!prediction?.id || prediction.status === 'failed' || prediction.status === 'canceled') {
      const reason = prediction?.error || 'Could not start 3D generation.'
      throw httpError(502, String(reason))
    }

    await updateJob(job.id, {
      source_path: sourcePath,
      prediction_id: prediction.id,
      status: 'processing',
      error: null,
    })

    return {
      id: job.id,
      status: 'processing',
      createdAt: job.created_at,
    }
  } catch (err) {
    const message = String(err.message || 'Could not start 3D generation.').slice(0, 500)
    await updateJob(job.id, {
      status: 'failed',
      error: message,
      source_path: sourcePath,
    }).catch((updateErr) => {
      console.error('article 3d failed to mark job failed:', updateErr.message)
    })
    if (err.status) throw err
    throw httpError(502, message)
  }
}

async function claimForSave(job) {
  let query = supabase
    .from('article_3d_jobs')
    .update({ status: 'saving', updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('user_id', job.user_id)
    .select('id')

  if (job.status === 'saving') {
    const cutoff = new Date(Date.now() - SAVE_STALE_MS).toISOString()
    query = query.eq('status', 'saving').lt('updated_at', cutoff)
  } else {
    query = query.eq('status', 'processing')
  }

  const { data, error } = await query
  if (error) throw mapDbError(error)
  return Boolean(data?.length)
}

async function saveModel(job, modelUrl) {
  const claimed = await claimForSave(job)
  if (!claimed) return loadJob(job.id, job.user_id)

  try {
    const response = await axios.get(modelUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: MAX_MODEL_BYTES,
      maxBodyLength: MAX_MODEL_BYTES,
    })
    const modelPath = `models/${job.id}.glb`
    const stored = await supabase.storage.from(BUCKET).upload(modelPath, Buffer.from(response.data), {
      contentType: 'model/gltf-binary',
      upsert: true,
    })
    if (stored.error) throw stored.error
    await updateJob(job.id, { status: 'ready', model_path: modelPath, error: null })
  } catch (err) {
    console.error('article 3d save failed:', err.message)
    await updateJob(job.id, {
      status: 'failed',
      error: 'The model was generated but could not be saved. Please try again.',
    })
  }
  return loadJob(job.id, job.user_id)
}

async function getJob(userId, id) {
  const job = await loadJob(id, userId)
  if (!job) return null
  if (job.status === 'ready' || job.status === 'failed') return present(job)

  if (job.status === 'saving') {
    const age = Date.now() - new Date(job.updated_at).getTime()
    if (age < SAVE_STALE_MS) return present(job)
  }

  if (!job.prediction_id) return present(job)

  const prediction = await replicateClient().predictions.get(job.prediction_id)

  if (prediction.status === 'succeeded') {
    const modelUrl = extractModelUrl(prediction.output)
    if (!modelUrl) {
      await updateJob(job.id, { status: 'failed', error: 'The model finished without a file.' })
      return present(await loadJob(job.id, userId))
    }
    return present(await saveModel(job, modelUrl))
  }

  if (prediction.status === 'failed' || prediction.status === 'canceled') {
    const message = String(prediction.error || '3D generation failed.').slice(0, 500)
    await updateJob(job.id, { status: 'failed', error: message })
    return present(await loadJob(job.id, userId))
  }

  return present(job)
}

async function readModel(userId, id) {
  const job = await loadJob(id, userId)
  if (!job) return null
  if (job.status !== 'ready' || !job.model_path) {
    const message = job.status === 'failed'
      ? (job.error || '3D generation failed.')
      : 'Model is not ready.'
    throw httpError(409, message)
  }

  const downloaded = await supabase.storage.from(BUCKET).download(job.model_path)
  if (downloaded.error || !downloaded.data) {
    throw httpError(502, 'Could not load the 3D model.')
  }
  return Buffer.from(await downloaded.data.arrayBuffer())
}

module.exports = { createJob, getJob, readModel }
