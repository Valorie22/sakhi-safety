import { Router } from 'express';
import { z } from 'zod';
import { admin, asUser } from '../supabase.js';
import { ApiError } from '../middleware/error.js';
import { authenticate, caller } from '../middleware/auth.js';

export const meRouter = Router();
meRouter.use(authenticate);

meRouter.get('/', async (req, res, next) => {
  try {
    const me = caller(req);
    const [{ data: profile }, { data: settings }] = await Promise.all([
      admin.from('profiles').select('id, full_name, email, phone, role, created_at').eq('id', me.id).single(),
      admin.from('user_settings').select('*').eq('user_id', me.id).maybeSingle(),
    ]);

    res.json({ profile, settings, officer: me.officer ?? null });
  } catch (err) {
    next(err);
  }
});

meRouter.patch('/', async (req, res, next) => {
  try {
    const me = caller(req);
    const body = z
      .object({
        fullName: z.string().min(1).max(120).optional(),
        phone: z.string().max(30).optional(),
      })
      .parse(req.body);

    const patch: Record<string, unknown> = {};
    if (body.fullName !== undefined) patch.full_name = body.fullName;
    if (body.phone !== undefined) patch.phone = body.phone;

    if (Object.keys(patch).length === 0) throw new ApiError(400, 'empty_patch', 'Nothing to update');

    // Note: `role` is not in the accepted shape at all, so there is no path
    // here for a user to promote themselves. RLS blocks it a second time.
    const { data, error } = await admin
      .from('profiles')
      .update(patch)
      .eq('id', me.id)
      .select('id, full_name, email, phone, role')
      .single();

    if (error) throw new ApiError(500, 'update_failed', error.message);
    res.json({ profile: data });
  } catch (err) {
    next(err);
  }
});

/** The Safety Settings screen. */
meRouter.patch('/settings', async (req, res, next) => {
  try {
    const me = caller(req);
    const body = z
      .object({
        sosButtonEnabled: z.boolean().optional(),
        shakeEnabled: z.boolean().optional(),
        shakeThreshold: z.number().min(1.2).max(6).optional(),
        shakeCountRequired: z.number().int().min(2).max(10).optional(),
        shakeWindowMs: z.number().int().min(500).max(10000).optional(),
        shakeCooldownMs: z.number().int().min(0).max(300000).optional(),
        timerEnabled: z.boolean().optional(),
        timerDefaultSeconds: z.number().int().min(5).max(3600).optional(),
        defaultLevel: z.number().int().min(1).max(3).optional(),
        audioOptIn: z.boolean().optional(),
      })
      .parse(req.body);

    const map: Record<string, string> = {
      sosButtonEnabled: 'sos_button_enabled',
      shakeEnabled: 'shake_enabled',
      shakeThreshold: 'shake_threshold',
      shakeCountRequired: 'shake_count_required',
      shakeWindowMs: 'shake_window_ms',
      shakeCooldownMs: 'shake_cooldown_ms',
      timerEnabled: 'timer_enabled',
      timerDefaultSeconds: 'timer_default_seconds',
      defaultLevel: 'default_level',
      audioOptIn: 'audio_opt_in',
    };

    const patch: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(map)) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) patch[column] = value;
    }

    if (Object.keys(patch).length === 0) throw new ApiError(400, 'empty_patch', 'Nothing to update');

    const { data, error } = await admin
      .from('user_settings')
      .upsert({ user_id: me.id, ...patch }, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw new ApiError(500, 'update_failed', error.message);
    res.json({ settings: data });
  } catch (err) {
    next(err);
  }
});

/** Register this device for push. */
meRouter.post('/push-token', async (req, res, next) => {
  try {
    const me = caller(req);
    const { token } = z.object({ token: z.string().min(10).max(255).nullable() }).parse(req.body);

    const { error } = await admin.from('profiles').update({ push_token: token }).eq('id', me.id);
    if (error) throw new ApiError(500, 'update_failed', error.message);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/notifications', async (req, res, next) => {
  try {
    const me = caller(req);
    const { data, error } = await asUser(me.accessToken)
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ notifications: data ?? [] });
  } catch (err) {
    next(err);
  }
});

meRouter.post('/notifications/:id/read', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);

    // Through the caller's token, so RLS decides whether this row is theirs.
    const { error } = await asUser(me.accessToken)
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw new ApiError(500, 'update_failed', error.message);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Runtime knobs the app needs: ping interval, staleness threshold, audio caps. */
meRouter.get('/config', async (req, res, next) => {
  try {
    const me = caller(req);
    const { data, error } = await asUser(me.accessToken).from('system_config').select('key, value');
    if (error) throw new ApiError(500, 'query_failed', error.message);

    const config: Record<string, unknown> = {};
    for (const row of data ?? []) config[row.key] = row.value;
    res.json({ config });
  } catch (err) {
    next(err);
  }
});

/** Stations covering a point - used by the app to be honest about coverage. */
meRouter.get('/coverage', async (req, res, next) => {
  try {
    const me = caller(req);
    const { lat, lng } = z
      .object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) })
      .parse(req.query);

    const { data, error } = await asUser(me.accessToken).rpc('stations_covering', {
      p_lat: lat,
      p_lng: lng,
    });

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ stations: data ?? [] });
  } catch (err) {
    next(err);
  }
});
