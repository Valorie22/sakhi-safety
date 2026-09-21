import { Router } from 'express';
import { z } from 'zod';
import { admin, asUser } from '../supabase.js';
import { ApiError } from '../middleware/error.js';
import { authenticate, caller, requireActiveOfficer, requireRole } from '../middleware/auth.js';

export const policeRouter = Router();
policeRouter.use(authenticate, requireRole('police'), requireActiveOfficer);

/**
 * GET /api/v1/police/queue
 *
 * The shared station queue. Every officer at STN-1001 sees exactly this list;
 * what differs between them is only who has claimed what.
 *
 * Sorted the way the dashboard renders: critical first, then high, then plain
 * active, then work already in progress, then closed.
 */
policeRouter.get('/queue', async (req, res, next) => {
  try {
    const me = caller(req);
    const stationId = me.officer!.stationId;

    const includeClosed = z.coerce.boolean().default(false).parse(req.query.includeClosed ?? false);
    const statuses = includeClosed
      ? ['active', 'claimed', 'responding', 'on_scene', 'resolved', 'cancelled']
      : ['active', 'claimed', 'responding', 'on_scene'];

    const { data, error } = await admin
      .from('emergency_stations')
      .select(`
        distance_m, notified_at,
        emergency:emergencies!inner(
          id, emergency_code, level, status, trigger_type,
          created_at, claimed_at, created_lat, created_lng, address_hint,
          claimed_by_officer_id,
          reporter:profiles!emergencies_user_id_fkey(id, full_name, phone),
          officer:police_officers!emergencies_claimed_by_officer_id_fkey(
            id, badge_number, profile:profiles!police_officers_id_fkey(full_name))
        )
      `)
      .eq('station_id', stationId)
      .in('emergency.status', statuses)
      .order('notified_at', { ascending: false })
      .limit(200);

    if (error) throw new ApiError(500, 'query_failed', error.message);

    const rank: Record<string, number> = {
      active: 0, claimed: 1, responding: 1, on_scene: 1, resolved: 2, cancelled: 3,
    };

    const rows = (data ?? []).map((row: any) => ({
      ...row.emergency,
      distanceFromStationM: row.distance_m,
      notifiedAt: row.notified_at,
    }));

    rows.sort((a: any, b: any) => {
      const bucket = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      if (bucket !== 0) return bucket;
      if (a.level !== b.level) return b.level - a.level;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    res.json({ stationId, queue: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/police/emergencies/:id/claim
 *
 * "Take Case". The whole race lives inside one conditional UPDATE in
 * claim_emergency(); this route is just authentication plus a status code.
 * Losing officers get 409 with the winner's name, and learn about it through
 * their realtime subscription before this response even matters to them.
 */
policeRouter.post('/emergencies/:id/claim', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);

    const { data, error } = await admin.rpc('claim_emergency', {
      p_emergency_id: id,
      p_officer_id: me.id,
    });

    if (error) throw new ApiError(500, 'claim_failed', error.message);

    const result = data as { ok: boolean; reason?: string };
    if (result.ok) return res.json(result);

    const status =
      result.reason === 'already_claimed' ? 409
      : result.reason === 'not_found' ? 404
      : result.reason === 'not_routed_to_your_station' ? 403
      : 409;

    res.status(status).json(result);
  } catch (err) {
    next(err);
  }
});

/** claimed -> responding -> on_scene -> resolved, owning officer only. */
policeRouter.post('/emergencies/:id/status', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const { status, note } = z
      .object({
        status: z.enum(['responding', 'on_scene', 'resolved']),
        note: z.string().max(1000).optional(),
      })
      .parse(req.body);

    const { data, error } = await admin.rpc('advance_emergency_status', {
      p_emergency_id: id,
      p_officer_id: me.id,
      p_new_status: status,
      p_note: note ?? null,
    });

    if (error) throw new ApiError(500, 'status_failed', error.message);

    const result = data as { ok: boolean; reason?: string };
    if (result.ok) return res.json(result);
    res.status(result.reason === 'not_your_case' ? 403 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

/** An officer may raise the level on a case at their own station. */
policeRouter.post('/emergencies/:id/escalate', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const { level } = z.object({ level: z.number().int().min(2).max(3) }).parse(req.body);

    const { data: routed } = await admin
      .from('emergency_stations')
      .select('id')
      .eq('emergency_id', id)
      .eq('station_id', me.officer!.stationId)
      .maybeSingle();

    if (!routed) throw new ApiError(403, 'not_your_station', 'Case is not routed to your station');

    const { data, error } = await admin.rpc('escalate_emergency', {
      p_emergency_id: id,
      p_new_level: level,
      p_actor_id: me.id,
      p_automatic: false,
    });

    if (error) throw new ApiError(500, 'escalate_failed', error.message);
    const result = data as { ok: boolean };
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

/** The officer's own station record, for the dashboard header. */
policeRouter.get('/station', async (req, res, next) => {
  try {
    const me = caller(req);
    const { data, error } = await asUser(me.accessToken)
      .from('police_stations')
      .select('id, station_code, name, address, phone, lat, lng, coverage_radius_meters')
      .eq('id', me.officer!.stationId)
      .single();

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ station: data, officer: me.officer });
  } catch (err) {
    next(err);
  }
});
