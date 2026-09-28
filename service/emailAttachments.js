const supabase = require('../supabaseClient');
const AdmZip = require('adm-zip');
const pLimit = require('p-limit');

// Same concurrency-pool pattern catalogWorker.js already uses for its own
// batch image processing - a callout can carry dozens of photos, and
// downloading them one at a time (a plain for-await loop) took over 2
// minutes for a real 98-photo batch in testing. Bounded (not unlimited)
// concurrency avoids hammering Supabase Storage with 90+ simultaneous
// requests at once.
const DOWNLOAD_CONCURRENCY = 8;

// Resend (and most mail providers) cap total message size well below what a
// callout's photo batch can reach - 90+ raw phone photos can be hundreds of
// MB, and base64-encoding an attachment inflates it by ~33% on top of that.
// Capped conservatively on the raw (pre-base64) zip size so an oversized
// batch fails closed (see the null return below, same "attachment failure
// must never block the email itself" rule the single-file path already
// follows) rather than attempting a send that would just bounce.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB

// attachment is either:
//   { bucket, path, filename }         - a single file (PDF export, etc.)
//   { bucket, paths: [...], filename }  - several files, bundled into one
//                                         zip so the email carries a single
//                                         attachment instead of one per file
async function resolveEmailAttachment(attachment) {
  if (!attachment?.bucket) return null;

  if (attachment.paths?.length) {
    const limit = pLimit(DOWNLOAD_CONCURRENCY);
    const downloads = await Promise.all(attachment.paths.map((path, i) => limit(async () => {
      const { data, error } = await supabase.storage.from(attachment.bucket).download(path);
      if (error || !data) {
        console.error(`❌ Failed to download attachment ${i + 1}/${attachment.paths.length} (${path}):`, error?.message);
        return null; // one bad file shouldn't drop the whole batch
      }
      const buf = Buffer.from(await data.arrayBuffer());
      const ext = (path.split('.').pop() || 'jpg').split('?')[0].toLowerCase();
      return { name: `photo-${i + 1}.${ext}`, buf };
    })));

    const zip = new AdmZip();
    let added = 0;
    for (const file of downloads) {
      if (!file) continue;
      zip.addFile(file.name, file.buf);
      added++;
    }
    if (!added) return null;

    const zipBuf = zip.toBuffer();
    if (zipBuf.length > MAX_ATTACHMENT_BYTES) {
      console.warn(`⚠️ Zipped attachment too large (${(zipBuf.length / 1024 / 1024).toFixed(1)}MB) - sending without it.`);
      return null;
    }
    return { filename: attachment.filename || 'photos.zip', content: zipBuf.toString('base64') };
  }

  if (!attachment.path) return null;
  const { data, error } = await supabase.storage.from(attachment.bucket).download(attachment.path);
  if (error || !data) {
    console.error('❌ Failed to download email attachment from storage:', error?.message);
    return null; // attachment failure must never block the email itself
  }
  const buf = Buffer.from(await data.arrayBuffer());
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    console.warn(`⚠️ Attachment too large (${(buf.length / 1024 / 1024).toFixed(1)}MB) - sending without it.`);
    return null;
  }
  return { filename: attachment.filename || 'attachment.pdf', content: buf.toString('base64') };
}

module.exports = { resolveEmailAttachment };
