// One rule for the order inspection photos are shown, exported and emailed:
// the order they were TAKEN. The original camera file name carries that
// (IMG_0012, 20260914_150712, photo-3), and it survives in the storage path's
// last segment. Upload time is the fallback, because a photographer may pick
// files in any order and the upload time then reflects the picking order.
//
// Identical copy of the frontend/src/lib/photoSequence.js (sans the
// upload-time File helper); keep the two in step.

const fileName = (p) => String(p?.storage_path || p?.path || '').split('/').pop().toLowerCase()

// "img_0012.jpg" -> "img_#.jpg". Two files share a template when they came
// from the same naming scheme (same camera / app).
const template = (name) => name.replace(/\.[a-z0-9]+$/, '').replace(/\d+/g, '#')

// Natural compare: digit runs compare as numbers (no Number(), so long runs
// never lose precision), everything else as text.
function naturalCompare(a, b) {
  const ax = a.match(/\d+|\D+/g) || []
  const bx = b.match(/\d+|\D+/g) || []
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const x = ax[i]
    const y = bx[i]
    if (x === y) continue
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const xs = x.replace(/^0+(?=\d)/, '')
      const ys = y.replace(/^0+(?=\d)/, '')
      if (xs.length !== ys.length) return xs.length - ys.length
      if (xs !== ys) return xs < ys ? -1 : 1
      continue
    }
    return x < y ? -1 : 1
  }
  return ax.length - bx.length
}

const time = (p) => {
  const t = new Date(p?.created_at).getTime()
  return Number.isNaN(t) ? 0 : t
}
const byUploadTime = (a, b) => time(a) - time(b) || String(a?.id ?? '').localeCompare(String(b?.id ?? ''))

// Returns a NEW array. If every photo follows one naming scheme, order by file
// number (upload time, then id, break ties). If schemes are mixed the numbers
// are not comparable, so the whole list falls back to upload time.
function sortPhotosInSequence(photos) {
  const list = Array.isArray(photos) ? [...photos] : []
  if (list.length < 2) return list
  const schemes = new Set(list.map((p) => template(fileName(p))))
  if (schemes.size > 1) return list.sort(byUploadTime)
  return list.sort((a, b) => naturalCompare(fileName(a), fileName(b)) || byUploadTime(a, b))
}

// Sort the photos of a fetched report (or reports) in place-safe fashion.
function withSortedPhotos(report) {
  if (!report || !Array.isArray(report.inspection_report_photos)) return report
  return { ...report, inspection_report_photos: sortPhotosInSequence(report.inspection_report_photos) }
}

module.exports = { sortPhotosInSequence, withSortedPhotos };
