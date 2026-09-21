import { Router } from 'express';
import { z } from 'zod';
import { admin, asUser } from '../supabase.js';
import { ApiError } from '../middleware/error.js';
import { authenticate, caller } from '../middleware/auth.js';
import { contactSearchLimiter } from '../middleware/rateLimit.js';

export const contactsRouter = Router();
contactsRouter.use(authenticate);

/**
 * POST /api/v1/contacts/search
 *
 * Exact-email lookup only - no prefix or fuzzy matching, which would turn this
 * into a directory scraper. Rate limited hard, and the response deliberately
 * carries no phone number: you learn that an account exists and its display
 * name, nothing more, and only once you know the address already.
 */
contactsRouter.post('/search', contactSearchLimiter, async (req, res, next) => {
  try {
    const me = caller(req);
    const { email } = z.object({ email: z.string().email().max(320) }).parse(req.body);

    if (email.toLowerCase() === (me.email ?? '').toLowerCase()) {
      throw new ApiError(400, 'self_search', 'That is your own account');
    }

    const { data, error } = await admin
      .from('profiles')
      .select('id, full_name, role')
      .eq('email', email)
      .maybeSingle();

    if (error) throw new ApiError(500, 'query_failed', error.message);

    // Police and admin accounts are not addable as family contacts.
    if (!data || data.role !== 'user') {
      return res.json({ found: false, user: null });
    }

    const { data: existing } = await admin
      .from('emergency_contacts')
      .select('id, status')
      .eq('owner_id', me.id)
      .eq('contact_id', data.id)
      .maybeSingle();

    res.json({
      found: true,
      user: { id: data.id, fullName: data.full_name },
      existingRequest: existing ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/** All contact edges the caller is on, in either direction. */
contactsRouter.get('/', async (req, res, next) => {
  try {
    const me = caller(req);
    const supabase = asUser(me.accessToken);

    const [mine, theirs] = await Promise.all([
      supabase
        .from('emergency_contacts')
        .select('id, status, relationship, requested_at, responded_at, contact:profiles!emergency_contacts_contact_id_fkey(id, full_name, phone)')
        .eq('owner_id', me.id)
        .neq('status', 'removed')
        .order('requested_at', { ascending: false }),
      supabase
        .from('emergency_contacts')
        .select('id, status, relationship, requested_at, responded_at, owner:profiles!emergency_contacts_owner_id_fkey(id, full_name, phone)')
        .eq('contact_id', me.id)
        .neq('status', 'removed')
        .order('requested_at', { ascending: false }),
    ]);

    if (mine.error) throw new ApiError(500, 'query_failed', mine.error.message);
    if (theirs.error) throw new ApiError(500, 'query_failed', theirs.error.message);

    res.json({
      // People who will be alerted when I trigger an SOS.
      myCircle: mine.data ?? [],
      // People whose alerts I will receive.
      protecting: theirs.data ?? [],
    });
  } catch (err) {
    next(err);
  }
});

contactsRouter.post('/requests', async (req, res, next) => {
  try {
    const me = caller(req);
    const { contactId, relationship } = z
      .object({
        contactId: z.string().uuid(),
        relationship: z.string().max(60).optional(),
      })
      .parse(req.body);

    if (contactId === me.id) throw new ApiError(400, 'self_request', 'You cannot add yourself');

    const { data: target } = await admin
      .from('profiles')
      .select('id, role')
      .eq('id', contactId)
      .maybeSingle();

    if (!target || target.role !== 'user') {
      throw new ApiError(404, 'not_found', 'No such user');
    }

    const { data, error } = await admin
      .from('emergency_contacts')
      .upsert(
        {
          owner_id: me.id,
          contact_id: contactId,
          relationship: relationship ?? null,
          status: 'pending',
          requested_at: new Date().toISOString(),
          responded_at: null,
        },
        { onConflict: 'owner_id,contact_id' },
      )
      .select()
      .single();

    if (error) throw new ApiError(500, 'request_failed', error.message);

    await admin.from('notifications').upsert(
      {
        recipient_id: contactId,
        type: 'contact_request',
        title: 'Safety circle request',
        body: `${me.fullName || 'Someone'} wants you as an emergency contact.`,
        payload: { contact_request_id: data.id, from: me.id },
        dedupe_key: null,
      },
      { ignoreDuplicates: false },
    );

    res.status(201).json({ request: data });
  } catch (err) {
    next(err);
  }
});

/** Accept or decline a request addressed to me. */
contactsRouter.post('/requests/:id/respond', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);
    const { action } = z.object({ action: z.enum(['accept', 'decline']) }).parse(req.body);

    const { data: row } = await admin
      .from('emergency_contacts')
      .select('id, owner_id, contact_id, status')
      .eq('id', id)
      .maybeSingle();

    if (!row) throw new ApiError(404, 'not_found', 'No such request');
    if (row.contact_id !== me.id) {
      throw new ApiError(403, 'forbidden', 'This request was not addressed to you');
    }
    if (row.status !== 'pending') {
      throw new ApiError(409, 'already_answered', `Request is already ${row.status}`);
    }

    const status = action === 'accept' ? 'accepted' : 'declined';

    const { error } = await admin
      .from('emergency_contacts')
      .update({ status, responded_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw new ApiError(500, 'respond_failed', error.message);

    await admin.from('notifications').insert({
      recipient_id: row.owner_id,
      type: action === 'accept' ? 'contact_accepted' : 'contact_declined',
      title: action === 'accept' ? 'Contact accepted' : 'Contact declined',
      body:
        action === 'accept'
          ? `${me.fullName || 'Someone'} joined your safety circle.`
          : `${me.fullName || 'Someone'} declined your request.`,
      payload: { contact_id: me.id },
    });

    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

/** Remove someone from my circle, or remove myself from someone else's. */
contactsRouter.delete('/:id', async (req, res, next) => {
  try {
    const me = caller(req);
    const id = z.string().uuid().parse(req.params.id);

    const { data: row } = await admin
      .from('emergency_contacts')
      .select('id, owner_id, contact_id')
      .eq('id', id)
      .maybeSingle();

    if (!row) throw new ApiError(404, 'not_found', 'No such contact');
    if (row.owner_id !== me.id && row.contact_id !== me.id) {
      throw new ApiError(403, 'forbidden', 'Not your contact');
    }

    const { error } = await admin
      .from('emergency_contacts')
      .update({ status: 'removed', responded_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw new ApiError(500, 'remove_failed', error.message);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
