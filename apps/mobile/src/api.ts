import { supabase } from './supabase';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when retrying later could plausibly succeed. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = 15000 } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeader()),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const err = parsed?.error ?? {};
      throw new ApiError(res.status, err.code ?? 'http_error', err.message ?? res.statusText, parsed);
    }

    return parsed as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // A network failure or a timeout - status 0 marks it retryable.
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, 'network_error', message);
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  me: () => request<{ profile: any; settings: any; officer: any }>('/api/v1/me'),
  updateProfile: (body: { fullName?: string; phone?: string }) =>
    request<{ profile: any }>('/api/v1/me', { method: 'PATCH', body }),
  updateSettings: (body: Record<string, unknown>) =>
    request<{ settings: any }>('/api/v1/me/settings', { method: 'PATCH', body }),
  registerPushToken: (token: string | null) =>
    request<{ ok: boolean }>('/api/v1/me/push-token', { method: 'POST', body: { token } }),
  config: () => request<{ config: Record<string, number> }>('/api/v1/me/config'),
  coverage: (lat: number, lng: number) =>
    request<{ stations: Array<{ station_code: string; name: string; distance_m: number }> }>(
      `/api/v1/me/coverage?lat=${lat}&lng=${lng}`,
    ),
  notifications: () => request<{ notifications: any[] }>('/api/v1/me/notifications'),
  markRead: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/me/notifications/${id}/read`, { method: 'POST' }),

  contacts: () => request<{ myCircle: any[]; protecting: any[] }>('/api/v1/contacts'),
  searchContact: (email: string) =>
    request<{ found: boolean; user: { id: string; fullName: string } | null; existingRequest: any }>(
      '/api/v1/contacts/search',
      { method: 'POST', body: { email } },
    ),
  requestContact: (contactId: string, relationship?: string) =>
    request<{ request: any }>('/api/v1/contacts/requests', {
      method: 'POST',
      body: { contactId, relationship },
    }),
  respondContact: (id: string, action: 'accept' | 'decline') =>
    request<{ ok: boolean }>(`/api/v1/contacts/requests/${id}/respond`, {
      method: 'POST',
      body: { action },
    }),
  removeContact: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/contacts/${id}`, { method: 'DELETE' }),

  triggerEmergency: (body: {
    clientRequestId: string;
    triggerType: 'button' | 'shake' | 'timer';
    level: number;
    lat: number;
    lng: number;
    accuracy?: number;
    addressHint?: string;
  }) => request<TriggerResult>('/api/v1/emergencies', { method: 'POST', body, timeoutMs: 20000 }),

  activeEmergency: () => request<{ emergency: any | null }>('/api/v1/emergencies/active'),
  watching: () => request<{ emergencies: any[] }>('/api/v1/emergencies/watching'),
  emergency: (id: string) => request<{ emergency: any }>(`/api/v1/emergencies/${id}`),
  timeline: (id: string) => request<{ timeline: any[] }>(`/api/v1/emergencies/${id}/timeline`),
  locations: (id: string, limit = 100) =>
    request<{ locations: any[] }>(`/api/v1/emergencies/${id}/locations?limit=${limit}`),
  ping: (
    id: string,
    body: { lat: number; lng: number; accuracy?: number; speed?: number; heading?: number; recordedAt?: string },
  ) => request<{ ok: boolean; reason?: string }>(`/api/v1/emergencies/${id}/locations`, { method: 'POST', body }),
  cancelEmergency: (id: string, reason?: string) =>
    request<{ ok: boolean }>(`/api/v1/emergencies/${id}/cancel`, { method: 'POST', body: { reason } }),
  escalate: (id: string, level: 2 | 3) =>
    request<{ ok: boolean }>(`/api/v1/emergencies/${id}/escalate`, { method: 'POST', body: { level } }),

  startAudioSegment: (id: string, segmentIndex: number) =>
    request<{ audioId: string; uploadUrl: string; token: string; storagePath: string }>(
      `/api/v1/emergencies/${id}/audio`,
      { method: 'POST', body: { segmentIndex } },
    ),
  finishAudioSegment: (
    id: string,
    audioId: string,
    body: { status: 'uploaded' | 'failed'; durationSeconds?: number; sizeBytes?: number; errorMessage?: string },
  ) => request<{ ok: boolean }>(`/api/v1/emergencies/${id}/audio/${audioId}`, { method: 'PATCH', body }),
  audioSegments: (id: string) => request<{ segments: any[] }>(`/api/v1/emergencies/${id}/audio`),
  audioUrl: (id: string, audioId: string) =>
    request<{ url: string; expiresInSeconds: number }>(`/api/v1/emergencies/${id}/audio/${audioId}/url`),

  policeQueue: (includeClosed = false) =>
    request<{ stationId: string; queue: any[] }>(`/api/v1/police/queue?includeClosed=${includeClosed}`),
  policeStation: () => request<{ station: any; officer: any }>('/api/v1/police/station'),
  claimCase: (id: string) =>
    request<ClaimResult>(`/api/v1/police/emergencies/${id}/claim`, { method: 'POST' }),
  setCaseStatus: (id: string, status: 'responding' | 'on_scene' | 'resolved', note?: string) =>
    request<{ ok: boolean }>(`/api/v1/police/emergencies/${id}/status`, {
      method: 'POST',
      body: { status, note },
    }),
  policeEscalate: (id: string, level: 2 | 3) =>
    request<{ ok: boolean }>(`/api/v1/police/emergencies/${id}/escalate`, { method: 'POST', body: { level } }),

  adminStations: () => request<{ stations: any[] }>('/api/v1/admin/stations'),
  createStation: (body: {
    name: string; lat: number; lng: number; coverageRadiusMeters: number; address?: string; phone?: string;
  }) => request<{ station: any }>('/api/v1/admin/stations', { method: 'POST', body }),
  updateStation: (id: string, body: Record<string, unknown>) =>
    request<{ station: any }>(`/api/v1/admin/stations/${id}`, { method: 'PATCH', body }),
  adminOfficers: (stationId?: string) =>
    request<{ officers: any[] }>(`/api/v1/admin/officers${stationId ? `?stationId=${stationId}` : ''}`),
  createOfficer: (body: {
    email: string; password: string; fullName: string; stationId: string; badgeNumber: string; rank?: string;
  }) => request<{ officer: any }>('/api/v1/admin/officers', { method: 'POST', body }),
  updateOfficer: (id: string, body: Record<string, unknown>) =>
    request<{ officer: any }>(`/api/v1/admin/officers/${id}`, { method: 'PATCH', body }),
};

export interface TriggerResult {
  ok: boolean;
  idempotent_replay: boolean;
  emergency_id: string;
  emergency_code: string;
  level: number;
  status: string;
  stations_notified?: number;
  station_codes?: string[];
  contacts_notified?: number;
}

export interface ClaimResult {
  ok: boolean;
  reason?: string;
  officer_name?: string;
  badge_number?: string;
  station_code?: string;
  claimed_by_officer_id?: string;
}
