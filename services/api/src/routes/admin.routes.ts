import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../supabase.js';
import { ApiError } from '../middleware/error.js';
import { authenticate, caller, requireRole } from '../middleware/auth.js';

/**
 * Admin surface: stations and officer accounts.
 *
 * This is the ONLY path that can mint a police account. There is no public
 * police registration anywhere in the system, and nothing here is reachable
 * without an existing admin profile - which itself is only ever provisioned by
 * a seed script or by hand in the database.
 */
export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('admin'));

async function audit(
  adminId: string,
  action: string,
  table: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  await admin.from('admin_audit_log').insert({
    admin_id: adminId,
    action,
    target_table: table,
    target_id: targetId,
    details,
  });
}

const stationBody = z.object({
  name: z.string().min(2).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  coverageRadiusMeters: z.number().positive().max(200000),
  address: z.string().max(300).optional(),
  phone: z.string().max(30).optional(),
});

adminRouter.get('/stations', async (_req, res, next) => {
  try {
    const { data, error } = await admin
      .from('police_stations')
      .select('id, station_code, name, address, phone, lat, lng, coverage_radius_meters, is_active, created_at')
      .order('station_code');

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ stations: data ?? [] });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/stations', async (req, res, next) => {
  try {
    const me = caller(req);
    const body = stationBody.parse(req.body);

    // PostgREST cannot write a geography literal directly, so the point is
    // built in SQL via a helper RPC.
    const { data, error } = await admin.rpc('admin_create_station', {
      p_name: body.name,
      p_lat: body.lat,
      p_lng: body.lng,
      p_radius: body.coverageRadiusMeters,
      p_address: body.address ?? null,
      p_phone: body.phone ?? null,
    });

    if (error) throw new ApiError(500, 'create_failed', error.message);

    const station = data as { id: string; station_code: string };
    await audit(me.id, 'create_station', 'police_stations', station.id, body);
    res.status(201).json({ station });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/stations/:id', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = stationBody.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);

    const { data, error } = await admin.rpc('admin_update_station', {
      p_id: id,
      p_name: body.name ?? null,
      p_lat: body.lat ?? null,
      p_lng: body.lng ?? null,
      p_radius: body.coverageRadiusMeters ?? null,
      p_address: body.address ?? null,
      p_phone: body.phone ?? null,
      p_is_active: body.isActive ?? null,
    });

    if (error) throw new ApiError(500, 'update_failed', error.message);
    await audit(me.id, 'update_station', 'police_stations', id, body);
    res.json({ station: data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/officers', async (req, res, next) => {
  try {
    const stationId = z.string().uuid().optional().parse(req.query.stationId ?? undefined);

    let query = admin
      .from('police_officers')
      .select('id, station_id, badge_number, rank, is_active, created_at, profile:profiles!police_officers_id_fkey(full_name, email), station:police_stations(station_code, name)')
      .order('badge_number');

    if (stationId) query = query.eq('station_id', stationId);

    const { data, error } = await query;
    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ officers: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/**
 * Creates an officer: an auth user, a profile with role 'police', and the
 * police_officers row tying them to one station. All three, or none.
 */
adminRouter.post('/officers', async (req, res, next) => {
  try {
    const me = caller(req);
    const body = z
      .object({
        email: z.string().email().max(320),
        password: z.string().min(10).max(128),
        fullName: z.string().min(2).max(120),
        stationId: z.string().uuid(),
        badgeNumber: z.string().min(1).max(40),
        rank: z.string().max(60).optional(),
        phone: z.string().max(30).optional(),
      })
      .parse(req.body);

    const { data: station } = await admin
      .from('police_stations')
      .select('id, station_code')
      .eq('id', body.stationId)
      .maybeSingle();

    if (!station) throw new ApiError(404, 'no_such_station', 'Station does not exist');

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: { full_name: body.fullName, phone: body.phone },
    });

    if (createError || !created.user) {
      throw new ApiError(400, 'auth_create_failed', createError?.message ?? 'Could not create account');
    }

    const userId = created.user.id;

    // The signup trigger already made the profile with role 'user'; promote it.
    const { error: roleError } = await admin
      .from('profiles')
      .update({ role: 'police', full_name: body.fullName, phone: body.phone ?? null })
      .eq('id', userId);

    if (roleError) {
      await admin.auth.admin.deleteUser(userId);
      throw new ApiError(500, 'role_failed', roleError.message);
    }

    const { error: officerError } = await admin.from('police_officers').insert({
      id: userId,
      station_id: body.stationId,
      badge_number: body.badgeNumber,
      rank: body.rank ?? null,
    });

    if (officerError) {
      // Roll the whole thing back rather than leaving an orphaned police
      // profile with no station - that account would fail closed, but it would
      // also be invisible in the officer list and confusing to debug.
      await admin.auth.admin.deleteUser(userId);
      throw new ApiError(400, 'officer_create_failed', officerError.message);
    }

    await audit(me.id, 'create_officer', 'police_officers', userId, {
      email: body.email,
      badge_number: body.badgeNumber,
      station_code: station.station_code,
    });

    res.status(201).json({
      officer: { id: userId, email: body.email, badgeNumber: body.badgeNumber, stationId: body.stationId },
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/officers/:id', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        isActive: z.boolean().optional(),
        stationId: z.string().uuid().optional(),
        badgeNumber: z.string().min(1).max(40).optional(),
        rank: z.string().max(60).optional(),
      })
      .parse(req.body);

    const patch: Record<string, unknown> = {};
    if (body.isActive !== undefined) patch.is_active = body.isActive;
    if (body.stationId !== undefined) patch.station_id = body.stationId;
    if (body.badgeNumber !== undefined) patch.badge_number = body.badgeNumber;
    if (body.rank !== undefined) patch.rank = body.rank;

    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, 'empty_patch', 'Nothing to update');
    }

    const { data, error } = await admin
      .from('police_officers')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new ApiError(500, 'update_failed', error.message);
    await audit(me.id, 'update_officer', 'police_officers', id, body);
    res.json({ officer: data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/audit', async (_req, res, next) => {
  try {
    const { data, error } = await admin
      .from('admin_audit_log')
      .select('*, admin:profiles!admin_audit_log_admin_id_fkey(full_name, email)')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ entries: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/** Who has opened which piece of audio evidence. */
adminRouter.get('/evidence-access', async (_req, res, next) => {
  try {
    const { data, error } = await admin
      .from('evidence_access_log')
      .select('*, actor:profiles!evidence_access_log_actor_id_fkey(full_name, email)')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ entries: data ?? [] });
  } catch (err) {
    next(err);
  }
});
