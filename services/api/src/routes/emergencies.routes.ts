import { Router } from 'express';
import { z } from 'zod';
import { admin, asUser } from '../supabase.js';
import { ApiError } from '../middleware/error.js';
import { authenticate, caller } from '../middleware/auth.js';
import { locationLimiter, sosLimiter } from '../middleware/rateLimit.js';
import { env } from '../env.js';

export const emergenciesRouter = Router();
emergenciesRouter.use(authenticate);

const AUDIO_BUCKET = 'emergency-audio';

const coordinate = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().max(100000).optional(),
});

const triggerBody = coordinate.extend({
  // Client-generated. This is what makes a retried SOS idempotent.
  clientRequestId: z.string().uuid(),
  triggerType: z.enum(['button', 'shake', 'timer']),
  level: z.number().int().min(1).max(3).default(1),
  addressHint: z.string().max(500).optional(),
});

/**
 * POST /api/v1/emergencies
 *
 * Creates the incident, runs the PostGIS radius query, fans out to every
 * covering station and to accepted contacts, and starts the timeline - all in
 * one database transaction, so a half-dispatched emergency cannot exist.
 *
 * Retrying with the same clientRequestId returns the original emergency.
 */
emergenciesRouter.post('/', sosLimiter, async (req, res, next) => {
  try {
    const me = caller(req);
    const body = triggerBody.parse(req.body);

    const { data, error } = await admin.rpc('trigger_emergency', {
      p_user_id: me.id,
      p_client_request_id: body.clientRequestId,
      p_trigger_type: body.triggerType,
      p_level: body.level,
      p_lat: body.lat,
      p_lng: body.lng,
      p_accuracy: body.accuracy ?? null,
      p_address_hint: body.addressHint ?? null,
    });

    if (error) throw new ApiError(500, 'dispatch_failed', error.message);

    const result = data as { idempotent_replay: boolean; stations_notified?: number };
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

/** The caller's own still-running emergency, if any. */
emergenciesRouter.get('/active', async (req, res, next) => {
  try {
    const me = caller(req);
    const { data, error } = await admin
      .from('emergencies')
      .select('*')
      .eq('user_id', me.id)
      .in('status', ['active', 'claimed', 'responding', 'on_scene'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ emergency: data ?? null });
  } catch (err) {
    next(err);
  }
});

/**
 * Emergencies the caller can see because they are a trusted contact - the
 * "someone in my circle needs help" feed.
 */
emergenciesRouter.get('/watching', async (req, res, next) => {
  try {
    const me = caller(req);
    // Read through the caller's own token so RLS, not this query, decides.
    const supabase = asUser(me.accessToken);
    const { data, error } = await supabase
      .from('emergencies')
      .select('*, reporter:profiles!emergencies_user_id_fkey(id, full_name, phone)')
      .neq('user_id', me.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ emergencies: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/** Full detail. RLS decides whether the caller may see it at all. */
emergenciesRouter.get('/:id', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const supabase = asUser(me.accessToken);

    const { data, error } = await supabase
      .from('emergencies')
      .select(`
        *,
        reporter:profiles!emergencies_user_id_fkey(id, full_name, phone),
        stations:emergency_stations(station_id, distance_m, notified_at,
          station:police_stations(station_code, name, phone)),
        officer:police_officers!emergencies_claimed_by_officer_id_fkey(
          id, badge_number, rank, station:police_stations(station_code, name))
      `)
      .eq('id', id)
      .maybeSingle();

    if (error) throw new ApiError(500, 'query_failed', error.message);
    if (!data) throw new ApiError(404, 'not_found', 'No such emergency, or you are not authorised to see it');

    res.json({ emergency: data });
  } catch (err) {
    next(err);
  }
});

emergenciesRouter.get('/:id/timeline', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const { data, error } = await asUser(me.accessToken)
      .from('emergency_timeline')
      .select('*')
      .eq('emergency_id', id)
      .order('created_at', { ascending: true });

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ timeline: data ?? [] });
  } catch (err) {
    next(err);
  }
});

emergenciesRouter.get('/:id/locations', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit ?? 100);

    // lat/lng are generated columns on the table itself - not a view, which
    // would run with the owner's rights and skip RLS.
    const { data, error } = await asUser(me.accessToken)
      .from('emergency_locations')
      .select('id, emergency_id, lat, lng, accuracy_meters, speed, heading, recorded_at')
      .eq('emergency_id', id)
      .order('recorded_at', { ascending: false })
      .limit(limit);

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ locations: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/** Live location ping. Refused by the database once the incident is closed. */
emergenciesRouter.post('/:id/locations', locationLimiter, async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = coordinate
      .extend({
        speed: z.number().optional(),
        heading: z.number().optional(),
        recordedAt: z.string().datetime().optional(),
      })
      .parse(req.body);

    const { data, error } = await admin.rpc('record_location', {
      p_emergency_id: id,
      p_user_id: me.id,
      p_lat: body.lat,
      p_lng: body.lng,
      p_accuracy: body.accuracy ?? null,
      p_speed: body.speed ?? null,
      p_heading: body.heading ?? null,
      p_recorded_at: body.recordedAt ?? new Date().toISOString(),
    });

    if (error) throw new ApiError(500, 'ping_failed', error.message);

    const result = data as { ok: boolean; reason?: string };
    if (!result.ok) {
      // 'emergency_closed' is a normal outcome, not a server fault: the app
      // uses it as the signal to stop its location loop.
      return res.status(result.reason === 'emergency_closed' ? 409 : 404).json(result);
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

emergenciesRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});

    const { data, error } = await admin.rpc('cancel_emergency', {
      p_emergency_id: id,
      p_user_id: me.id,
      p_reason: reason ?? null,
    });

    if (error) throw new ApiError(500, 'cancel_failed', error.message);
    const result = data as { ok: boolean };
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Manual escalation by the person in danger. Raises the level of the existing
 * incident; it never opens a second one.
 */
emergenciesRouter.post('/:id/escalate', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const { level } = z.object({ level: z.number().int().min(2).max(3) }).parse(req.body);

    const { data: owned } = await admin
      .from('emergencies')
      .select('id')
      .eq('id', id)
      .eq('user_id', me.id)
      .maybeSingle();

    if (!owned) throw new ApiError(403, 'not_your_emergency', 'Only the reporter may escalate');

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

// ---------------------------------------------------------------------------
// Audio evidence (level 2+)
// ---------------------------------------------------------------------------

/**
 * Registers an audio segment and hands back a short-lived signed UPLOAD url,
 * so the phone streams bytes straight to Storage without ever holding a key
 * that could read anyone else's evidence.
 */
emergenciesRouter.post('/:id/audio', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const { segmentIndex, mimeType } = z
      .object({
        segmentIndex: z.number().int().min(0).max(10000).default(0),
        mimeType: z.string().max(60).default('audio/m4a'),
      })
      .parse(req.body ?? {});

    const { data: emergency } = await admin
      .from('emergencies')
      .select('id, status, level')
      .eq('id', id)
      .eq('user_id', me.id)
      .maybeSingle();

    if (!emergency) throw new ApiError(404, 'not_found', 'No such emergency for this account');
    if (['resolved', 'cancelled'].includes(emergency.status)) {
      throw new ApiError(409, 'emergency_closed', 'Recording stops when the emergency closes');
    }
    if (emergency.level < 2) {
      throw new ApiError(409, 'level_too_low', 'Audio evidence starts at level 2');
    }

    const storagePath = `${id}/${String(segmentIndex).padStart(4, '0')}-${crypto.randomUUID()}.m4a`;

    const { data: signed, error: signError } = await admin.storage
      .from(AUDIO_BUCKET)
      .createSignedUploadUrl(storagePath);

    if (signError) throw new ApiError(500, 'sign_failed', signError.message);

    const { data: row, error: insertError } = await admin
      .from('emergency_audio')
      .insert({
        emergency_id: id,
        storage_path: storagePath,
        segment_index: segmentIndex,
        mime_type: mimeType,
        status: 'recording',
      })
      .select()
      .single();

    if (insertError) throw new ApiError(500, 'audio_register_failed', insertError.message);

    if (segmentIndex === 0) {
      await admin.from('emergency_timeline').insert({
        emergency_id: id,
        event_type: 'audio_started',
        event_data: { audio_id: row.id },
        actor_id: me.id,
      });
    }

    res.status(201).json({
      audioId: row.id,
      storagePath,
      uploadUrl: signed.signedUrl,
      token: signed.token,
      bucket: AUDIO_BUCKET,
    });
  } catch (err) {
    next(err);
  }
});

/** Called once the phone has finished pushing a segment. */
emergenciesRouter.patch('/:id/audio/:audioId', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const audioId = z.string().uuid().parse(req.params.audioId);
    const body = z
      .object({
        status: z.enum(['uploaded', 'failed']),
        durationSeconds: z.number().nonnegative().max(86400).optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        errorMessage: z.string().max(500).optional(),
      })
      .parse(req.body);

    const { data: owned } = await admin
      .from('emergencies')
      .select('id, emergency_code')
      .eq('id', id)
      .eq('user_id', me.id)
      .maybeSingle();
    if (!owned) throw new ApiError(404, 'not_found', 'No such emergency for this account');

    const { error } = await admin
      .from('emergency_audio')
      .update({
        status: body.status,
        duration_seconds: body.durationSeconds ?? null,
        size_bytes: body.sizeBytes ?? null,
        error_message: body.errorMessage ?? null,
        ended_at: new Date().toISOString(),
      })
      .eq('id', audioId)
      .eq('emergency_id', id);

    if (error) throw new ApiError(500, 'audio_update_failed', error.message);

    if (body.status === 'uploaded') {
      await admin.from('emergency_timeline').insert({
        emergency_id: id,
        event_type: 'audio_available',
        event_data: { audio_id: audioId, duration_seconds: body.durationSeconds ?? null },
      });

      // Tell the dispatched stations there is something to listen to.
      const { data: stations } = await admin
        .from('emergency_stations')
        .select('station_id')
        .eq('emergency_id', id);

      if (stations?.length) {
        await admin.from('notifications').upsert(
          stations.map((s: { station_id: string }) => ({
            recipient_station_id: s.station_id,
            emergency_id: id,
            type: 'audio_available',
            title: 'Audio evidence available',
            body: `Case ${owned.emergency_code} has new audio.`,
            payload: { emergency_id: id },
            dedupe_key: `audio_available:${audioId}`,
          })),
          { onConflict: 'recipient_station_id,emergency_id,dedupe_key', ignoreDuplicates: true },
        );
      }
    } else {
      await admin.from('emergency_timeline').insert({
        emergency_id: id,
        event_type: 'audio_failed',
        event_data: { audio_id: audioId, error: body.errorMessage ?? null },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Mints a short-lived signed URL for one audio segment.
 *
 * Authorisation is re-derived here rather than trusted from the client, and
 * every issue is written to evidence_access_log: for recordings of someone's
 * worst moment, "who listened, and when" has to be answerable.
 */
emergenciesRouter.get('/:id/audio/:audioId/url', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const audioId = z.string().uuid().parse(req.params.audioId);

    const { data: audio } = await admin
      .from('emergency_audio')
      .select('id, storage_path, emergency_id, status')
      .eq('id', audioId)
      .eq('emergency_id', id)
      .maybeSingle();

    if (!audio) throw new ApiError(404, 'not_found', 'No such audio segment');

    const { data: emergency } = await admin
      .from('emergencies')
      .select('user_id')
      .eq('id', id)
      .maybeSingle();

    if (!emergency) throw new ApiError(404, 'not_found', 'No such emergency');

    let authorised = emergency.user_id === me.id;

    if (!authorised && me.officer) {
      const { data: routed } = await admin
        .from('emergency_stations')
        .select('id')
        .eq('emergency_id', id)
        .eq('station_id', me.officer.stationId)
        .maybeSingle();
      authorised = Boolean(routed);
    }

    if (!authorised) {
      throw new ApiError(403, 'forbidden', 'Not authorised to access this evidence');
    }

    const { data: signed, error } = await admin.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(audio.storage_path, env.AUDIO_SIGNED_URL_TTL);

    if (error) throw new ApiError(500, 'sign_failed', error.message);

    await admin.from('evidence_access_log').insert({
      actor_id: me.id,
      emergency_id: id,
      audio_id: audioId,
      action: 'signed_url_issued',
    });

    res.json({ url: signed.signedUrl, expiresInSeconds: env.AUDIO_SIGNED_URL_TTL });
  } catch (err) {
    next(err);
  }
});

emergenciesRouter.get('/:id/audio', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const { data, error } = await asUser(me.accessToken)
      .from('emergency_audio')
      .select('id, segment_index, duration_seconds, status, started_at, ended_at')
      .eq('emergency_id', id)
      .order('segment_index', { ascending: true });

    if (error) throw new ApiError(500, 'query_failed', error.message);
    res.json({ segments: data ?? [] });
  } catch (err) {
    next(err);
  }
});
