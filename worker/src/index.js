const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

const ADMIN_MAX = 200 * 1024 * 1024;  // 200MB for admin
const ANON_MAX  =  50 * 1024 * 1024;  //  50MB for anonymous

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // POST /upload
    if (request.method === 'POST' && url.pathname === '/upload') {
      return handleUpload(request, env, url);
    }

    // GET /files  — list all files (admin only)
    if (request.method === 'GET' && url.pathname === '/files') {
      return handleList(request, env);
    }

    // GET /files/:key  — serve a file
    if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
      return handleGet(request, env, url);
    }

    // DELETE /files/:key  — delete (admin only)
    if (request.method === 'DELETE' && url.pathname.startsWith('/files/')) {
      return handleDelete(request, env, url);
    }

    return json(404, { error: 'Not found' });
  },
};

// ---- upload ----
async function handleUpload(request, env, url) {
  let formData;
  try { formData = await request.formData(); }
  catch { return json(400, { error: 'Invalid form data' }); }

  const file = formData.get('file');
  if (!file || typeof file === 'string') return json(400, { error: 'No file provided' });

  const adminKey = formData.get('adminKey') || '';
  const isAdmin = env.ADMIN_KEY && adminKey === env.ADMIN_KEY;
  const maxSize = isAdmin ? ADMIN_MAX : ANON_MAX;

  if (file.size > maxSize) {
    return json(413, { error: `文件过大（最大 ${Math.round(maxSize / 1024 / 1024)}MB）` });
  }

  const ts = Date.now();
  const safe = file.name.replace(/[^\w.\u4e00-\u9fa5-]/g, '_');
  const key = `${ts}_${safe}`;

  await env.BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: {
      contentType: file.type || 'application/octet-stream',
      contentDisposition: `inline; filename="${safe}"`,
    },
    customMetadata: { originalName: file.name, uploadedAt: new Date().toISOString() },
  });

  return json(200, { url: `${url.origin}/files/${key}`, key });
}

// ---- list (admin) ----
async function handleList(request, env) {
  if (!isAdmin(request, env)) return json(401, { error: 'Unauthorized' });

  const listed = await env.BUCKET.list();
  const files = listed.objects.map(o => ({
    key: o.key,
    name: o.key.replace(/^\d+_/, ''),
    size: o.size,
    uploaded: o.uploaded,
  }));

  return json(200, { files });
}

// ---- serve file ----
async function handleGet(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice(7));
  if (!key) return json(404, { error: 'Not found' });

  const object = await env.BUCKET.get(key);
  if (!object) return new Response('File not found', { status: 404, headers: CORS });

  const headers = new Headers(CORS);
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000');

  if (url.searchParams.get('dl')) {
    const name = object.customMetadata?.originalName || key.replace(/^\d+_/, '');
    headers.set('Content-Disposition', `attachment; filename="${name}"`);
  }

  return new Response(object.body, { headers });
}

// ---- delete (admin) ----
async function handleDelete(request, env, url) {
  if (!isAdmin(request, env)) return json(401, { error: 'Unauthorized' });

  const key = decodeURIComponent(url.pathname.slice(7));
  await env.BUCKET.delete(key);
  return json(200, { ok: true });
}

// ---- helpers ----
function isAdmin(request, env) {
  const key = request.headers.get('X-Admin-Key') || '';
  return env.ADMIN_KEY && key === env.ADMIN_KEY;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
