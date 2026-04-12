
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-gallery-id, x-filename',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const path = event.path.replace('/.netlify/functions/api', '').replace('/api', '') || '/';
  const method = event.httpMethod;

  let body = {};
  if (event.body && (event.headers['content-type'] || '').includes('application/json')) {
    try { body = JSON.parse(event.body); } catch(e) {}
  }

  // Get user from Supabase JWT
  const token = (event.headers.authorization || '').replace('Bearer ', '');
  let userId = null;
  if (token) {
    const { data } = await supabase.auth.getUser(token);
    if (data?.user) userId = data.user.id;
  }

  const ok = (data) => ({ statusCode: 200, headers, body: JSON.stringify(data) });
  const err = (msg, code) => ({ statusCode: code || 400, headers, body: JSON.stringify({ error: msg }) });

  try {

    // ── PHOTOGRAPHER ──
    if (path === '/photographer' && method === 'GET') {
      if (!userId) return err('Unauthorized', 401);
      const { data, error } = await supabase.from('photographers').select('*').eq('id', userId).single();
      if (error) return err(error.message);
      return ok(data);
    }

    if (path === '/photographer' && method === 'PUT') {
      if (!userId) return err('Unauthorized', 401);
      const { full_name, slug } = body;
      const { data, error } = await supabase.from('photographers').update({ full_name, slug }).eq('id', userId).select().single();
      if (error) return err(error.message);
      return ok(data);
    }

    // ── GALLERIES ──
    if (path === '/galleries' && method === 'GET') {
      if (!userId) return err('Unauthorized', 401);
      const { data, error } = await supabase.from('galleries').select('*, photos(count)').eq('photographer_id', userId).order('created_at', { ascending: false });
      if (error) return err(error.message);
      const galleries = (data || []).map(g => ({ ...g, photo_count: g.photos?.[0]?.count || 0 }));
      return ok(galleries);
    }

    if (path === '/galleries' && method === 'POST') {
      if (!userId) return err('Unauthorized', 401);
      const { name, price_nzd } = body;
      const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
      const { data, error } = await supabase.from('galleries').insert({ photographer_id: userId, name, slug, price_nzd: price_nzd || 10 }).select().single();
      if (error) return err(error.message);
      return ok(data);
    }

    if (path.startsWith('/galleries/') && method === 'PUT') {
      if (!userId) return err('Unauthorized', 401);
      const galleryId = path.split('/')[2];
      const { is_published } = body;
      const { data, error } = await supabase.from('galleries').update({ is_published }).eq('id', galleryId).eq('photographer_id', userId).select().single();
      if (error) return err(error.message);
      return ok(data);
    }

    if (path.startsWith('/galleries/') && method === 'DELETE') {
      if (!userId) return err('Unauthorized', 401);
      const galleryId = path.split('/')[2];
      await supabase.from('photos').delete().eq('gallery_id', galleryId).eq('photographer_id', userId);
      await supabase.from('galleries').delete().eq('id', galleryId).eq('photographer_id', userId);
      return ok({ success: true });
    }

    // ── UPLOAD ──
    if (path === '/upload' && method === 'POST') {
      if (!userId) return err('Unauthorized', 401);
      const galleryId = event.headers['x-gallery-id'];
      const filename = event.headers['x-filename'];
      const contentType = (event.headers['content-type'] || 'image/jpeg').split(';')[0];

      if (!galleryId || !filename) return err('Missing data', 400);

      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : Buffer.from(event.body, 'binary');

      const key = userId + '/' + galleryId + '/' + Date.now() + '-' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage.from('photos-original').upload(key, rawBody, { contentType });
      if (uploadError) return err('Upload failed: ' + uploadError.message, 500);

      const { data, error } = await supabase.from('photos').insert({
        gallery_id: galleryId,
        photographer_id: userId,
        filename,
        storage_path: key,
        size_bytes: rawBody.length
      }).select().single();

      if (error) return err(error.message);
      return ok(data);
    }

    // ── PUBLIC GALLERY ──
    if (path.startsWith('/public/') && method === 'GET') {
      const parts = path.split('/');
      const photographerSlug = parts[2];
      const gallerySlug = parts[3];

      const { data: photographers } = await supabase.from('photographers').select('id, full_name, slug').eq('slug', photographerSlug);
      if (!photographers?.length) return err('Not found', 404);
      const photographer = photographers[0];

      const { data: galleries } = await supabase.from('galleries').select('*').eq('photographer_id', photographer.id).eq('slug', gallerySlug).eq('is_published', true);
      if (!galleries?.length) return err('Not found', 404);
      const gallery = galleries[0];

      const { data: photos } = await supabase.from('photos').select('id, filename, storage_path').eq('gallery_id', gallery.id).order('sort_order').order('created_at');
      return ok({ photographer, gallery, photos: photos || [] });
    }

    // ── VISITORS ──
    if (path === '/visitors' && method === 'GET') {
      if (!userId) return err('Unauthorized', 401);
      const { data, error } = await supabase.from('visitors').select('*, galleries(name)').eq('photographer_id', userId).order('created_at', { ascending: false });
      if (error) return err(error.message);
      return ok((data || []).map(v => ({ ...v, gallery_name: v.galleries?.name })));
    }

    if (path === '/visitors' && method === 'POST') {
      const { gallery_id, photographer_id, full_name, email, phone } = body;
      if (!gallery_id || !full_name || !email) return err('Missing fields', 400);
      const { data } = await supabase.from('visitors').insert({ gallery_id, photographer_id, full_name, email, phone: phone || null }).select().single();
      return ok(data || { registered: true });
    }

    // ── ORDERS ──
    if (path === '/orders' && method === 'GET') {
      if (!userId) return err('Unauthorized', 401);
      const { data, error } = await supabase.from('orders').select('*, galleries(name)').eq('photographer_id', userId).order('created_at', { ascending: false });
      if (error) return err(error.message);
      return ok((data || []).map(o => ({ ...o, gallery_name: o.galleries?.name })));
    }

    // ── WATERMARK ──
    if (path === '/watermark' && method === 'GET') {
      if (!userId) return err('Unauthorized', 401);
      const { data } = await supabase.from('watermark_settings').select('*').eq('id', userId).single();
      return ok(data || {});
    }

    if (path === '/watermark' && method === 'POST') {
      if (!userId) return err('Unauthorized', 401);
      const { text, position, opacity } = body;
      const { data, error } = await supabase.from('watermark_settings').upsert({ id: userId, text, position, opacity }).select().single();
      if (error) return err(error.message);
      return ok(data);
    }

    return err('Not found', 404);

  } catch (e) {
    console.error(e.message);
    return err(e.message, 500);
  }
};
