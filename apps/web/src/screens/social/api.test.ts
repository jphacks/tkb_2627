import { describe, expect, it, vi } from 'vitest';
import { domesticTrip } from '@tkb/fixtures';
import { CONTRACT_MISMATCH, CSRF_HEADER, createHttpSocialApi, inviteTokenFrom } from './api.ts';
import { NOT_VISIBLE, errorText } from './messages.ts';
import { mockSnapshot } from './mockSocialApi.ts';

interface Call { url: string; init: RequestInit }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string) => json(status, { code, message: 'x', retryable: false, requestId: 'req_1' });

const LOGIN = { userId: 'user_a', displayName: 'A', csrfToken: 'csrf_token_value' };
const { snapshot } = mockSnapshot(domesticTrip);
const POST = {
  postId: 'post_1', postRevision: 1, authorDisplayName: 'A', title: 't', story: 's', visibility: 'public', groupId: null,
  area: '金沢', startDate: '2026-11-01', createdAt: '2026-10-24T00:00:00Z', snapshot,
};

/** fetch stub answering from a queue; records every call. */
function stub(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, api: createHttpSocialApi({ fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl };
}
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe('U08 http client: session and CSRF', () => {
  it('sends the CSRF token from login on every write and never on GET', async () => {
    const { api, calls } = stub(
      json(200, LOGIN),
      json(200, { items: [], nextCursor: null }),
      json(200, { previewToken: 'p'.repeat(20), snapshot, redactedFields: ['privateNotes'], expiresAt: '2026-10-24T00:10:00Z' }),
      json(201, POST),
      json(200, POST),
      new Response(null, { status: 204 }),
      json(201, { tripId: 'trip_copy', ownerId: 'user_a', revision: 1, validationState: 'needs_revalidation' }),
      json(201, { groupId: 'g1', name: 'g', role: 'owner', createdAt: '2026-10-24T00:00:00Z' }),
      json(201, { inviteUrl: 'http://127.0.0.1:5173/invite#tok', expiresAt: '2026-10-31T00:00:00Z' }),
      json(200, { groupId: 'g1', userId: 'user_a', membership: 'active' }),
      new Response(null, { status: 204 }),
    );
    expect((await api.login('demo-a', 'pw')).ok).toBe(true);
    expect(header(calls[0]!, CSRF_HEADER)).toBeUndefined();
    await api.getFeed('public');
    expect(calls[1]!.init.method).toBe('GET');
    expect(header(calls[1]!, CSRF_HEADER)).toBeUndefined();
    await api.previewPost({ tripId: 'trip_1', sourceRevision: 1, visibility: 'public', story: '' });
    await api.createPost('p'.repeat(20));
    await api.changeVisibility('post_1', 1, 'private', null);
    await api.deletePost('post_1');
    await api.copyPost('post_1', { newStartDate: '2026-12-01', timeZone: 'Asia/Tokyo' });
    await api.createGroup('g');
    await api.createInvite('g1');
    await api.acceptInvite('t'.repeat(20));
    await api.leaveGroup('g1', 'user_a');
    const writes = calls.slice(2);
    expect(writes.map(c => c.init.method)).toEqual(['POST', 'POST', 'PATCH', 'DELETE', 'POST', 'POST', 'POST', 'POST', 'DELETE']);
    for (const c of writes) expect(header(c, CSRF_HEADER)).toBe('csrf_token_value');
    for (const c of calls) {
      expect(c.init.credentials).toBe('same-origin');
      expect(c.init.cache).toBe('no-store');
    }
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ previewToken: 'p'.repeat(20), confirmed: true });
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ expectedPostRevision: 1, visibility: 'private', groupId: null });
  });

  it('drops the CSRF token after a 401 and after logout', async () => {
    const { api, calls } = stub(json(200, LOGIN), apiError(401, 'UNAUTHENTICATED'), apiError(401, 'UNAUTHENTICATED'));
    await api.login('demo-a', 'pw');
    const r = await api.createGroup('g');
    expect(r.ok).toBe(false);
    expect(header(calls[1]!, CSRF_HEADER)).toBe('csrf_token_value');
    await api.createGroup('g');
    expect(header(calls[2]!, CSRF_HEADER)).toBeUndefined();
  });

  it('restores the session with me() (K11 GET /auth/me)', async () => {
    const { api, calls } = stub(json(200, LOGIN), json(201, { groupId: 'g1', name: 'g', role: 'owner', createdAt: '2026-10-24T00:00:00Z' }));
    const me = await api.me();
    expect(me.ok && me.data).toEqual({ userId: 'user_a', displayName: 'A' });
    await api.createGroup('g');
    expect(calls[0]!.url).toBe('/api/v1/auth/me');
    expect(header(calls[1]!, CSRF_HEADER)).toBe('csrf_token_value');
  });
});

describe('U08 http client: response validation and errors', () => {
  it('a response that does not match the schema becomes an error (never a cast)', async () => {
    const { api } = stub(json(200, { items: [{ postId: 'p1' }], nextCursor: null }));
    const r = await api.getFeed('public');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INTERNAL');
      expect(errorText(r.error)).toBe(CONTRACT_MISMATCH);
    }
  });

  it('a snapshot with an extra private field is still parsed down to the allow-list', async () => {
    const leaky = structuredClone(POST) as typeof POST & { snapshot: { privateNotes?: string } };
    leaky.snapshot.privateNotes = 'SECRET';
    const { api } = stub(json(200, leaky));
    const r = await api.getPost('post_1');
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.ok ? r.data : null)).not.toContain('SECRET');
  });

  it('404 reads 見つからないか閲覧権限がありません', async () => {
    const { api } = stub(apiError(404, 'NOT_FOUND'));
    const r = await api.getPost('post_private');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(errorText(r.error)).toContain(NOT_VISIBLE);
    }
  });

  it('an unreadable error body falls back to the code for the HTTP status', async () => {
    const { api } = stub(new Response('<html>bad gateway</html>', { status: 502 }), new Response('nope', { status: 409 }));
    const a = await api.getFeed('public');
    expect(!a.ok && a.error.code).toBe('UNAVAILABLE');
    const b = await api.createGroup('g');
    expect(!b.ok && b.error.code).toBe('REVISION_CONFLICT');
  });

  it('a network failure is UNAVAILABLE and retryable', async () => {
    const { api } = stub(new TypeError('Failed to fetch'));
    const r = await api.getFeed('public');
    expect(!r.ok && r.error).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });

  it('invalid input is rejected before any request is sent', async () => {
    const { api, fetchImpl } = stub();
    expect((await api.getPost('../trips/x')).ok).toBe(false);
    expect((await api.previewPost({ tripId: 't', sourceRevision: 1, visibility: 'group', story: '' })).ok).toBe(false);
    expect((await api.copyPost('p1', { newStartDate: '2026-13-40', timeZone: 'Asia/Tokyo' })).ok).toBe(false);
    expect((await api.copyPost('p1', { newStartDate: '2026-12-01', timeZone: 'Not/AZone' })).ok).toBe(false);
    expect((await api.acceptInvite('short')).ok).toBe(false);
    expect((await api.createGroup('   ')).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('feed paging passes scope, limit and cursor in the query', async () => {
    const { api, calls } = stub(json(200, { items: [], nextCursor: null }));
    await api.getFeed('groups', 'abc_123');
    const url = new URL(calls[0]!.url, 'http://x');
    expect(url.pathname).toBe('/api/v1/posts');
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'groups', limit: '20', cursor: 'abc_123' });
  });
});

describe('inviteTokenFrom', () => {
  const t = 'A'.repeat(43);
  it('takes the token from the URL fragment, a bare #token or the token', () => {
    expect(inviteTokenFrom(`http://127.0.0.1:5173/invite#${t}`)).toBe(t);
    expect(inviteTokenFrom(`#${t}`)).toBe(t);
    expect(inviteTokenFrom(`  ${t} `)).toBe(t);
  });
  it('rejects short or malformed tokens', () => {
    expect(inviteTokenFrom('http://x/invite#short')).toBeNull();
    expect(inviteTokenFrom('http://x/invite')).toBeNull();
    expect(inviteTokenFrom(`#${'a'.repeat(20)}<script>`)).toBeNull();
  });
});
