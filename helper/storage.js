const LEGACY_BUCKET = 'POFY26';
const ACTIVE_BUCKET = 'POFY27';
const BUCKET_SEPARATOR = '::';

function parseFileRef(fileRef) {
  if (!fileRef) return { bucket: null, path: null };

  if (fileRef.startsWith('http')) {
    // Public URL
    let match = fileRef.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)/);
    if (match) return { bucket: match[1], path: decodeURIComponent(match[2]) };

    // Signed URL (strip query string)
    match = fileRef.match(/\/storage\/v1\/object\/sign\/([^/]+)\/([^?]+)/);
    if (match) return { bucket: match[1], path: decodeURIComponent(match[2]) };

    return { bucket: null, path: null };
  }

  if (fileRef.includes(BUCKET_SEPARATOR)) {
    const [bucket, ...rest] = fileRef.split(BUCKET_SEPARATOR);
    return { bucket, path: rest.join(BUCKET_SEPARATOR) };
  }

  return { bucket: LEGACY_BUCKET, path: fileRef }; // legacy bare path
}

function buildFileRef(path, bucket = ACTIVE_BUCKET) {
  return `${bucket}${BUCKET_SEPARATOR}${path}`;
}

async function resolveFileUrl(supabase, fileRef, expiresIn = 3600) {
  const { bucket, path } = parseFileRef(fileRef);
  if (!bucket || !path) return null;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function resolveFileUrls(supabase, fileRefs, expiresIn = 3600) {
  const unique = [...new Set(fileRefs.filter(Boolean))];
  if (!unique.length) return new Map();

  // Group refs by bucket
  const byBucket = new Map();
  for (const ref of unique) {
    const { bucket, path } = parseFileRef(ref);
    if (!bucket || !path) continue;
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push({ ref, path });
  }

  const resultMap = new Map();

  // One batch call per bucket, all buckets in parallel
  await Promise.all(
    [...byBucket.entries()].map(async ([bucket, items]) => {
      const paths = items.map(i => i.path);
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrls(paths, expiresIn);

      if (error || !data) return;

      // data is an array of { path, signedUrl, error }
      for (const result of data) {
        if (!result.signedUrl) continue;
        // match back to original ref by path
        const item = items.find(i => i.path === result.path);
        if (item) resultMap.set(item.ref, result.signedUrl);
      }
    })
  );

  return resultMap;
}

function getPublicUrl(supabase, fileRef) {
  const { bucket, path } = parseFileRef(fileRef);
  if (!bucket || !path) return null;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl ?? null;
}

function getPublicUrls(supabase, fileRefs) {
  const unique = [...new Set(fileRefs.filter(Boolean))];
  const resultMap = new Map();
  for (const ref of unique) {
    const url = getPublicUrl(supabase, ref);
    if (url) resultMap.set(ref, url);
  }
  return resultMap;
}

module.exports = { parseFileRef, buildFileRef, LEGACY_BUCKET, ACTIVE_BUCKET, resolveFileUrl, resolveFileUrls, getPublicUrl, getPublicUrls };