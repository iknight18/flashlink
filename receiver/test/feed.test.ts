import { describe, expect, it } from 'vitest';
import { Feed, type FeedRow } from '../src/feed';

/** A feed whose row updates are recorded, latest state per row id. */
function setup() {
  const seen = new Map<number, FeedRow>();
  const feed = new Feed((row) => seen.set(row.id, { ...row }));
  return { feed, seen, rows: () => feed.rows.map((r) => ({ ...r })) };
}

describe('Feed', () => {
  it('streams progress into one live row that becomes verified on the message', () => {
    const { feed, rows } = setup();
    feed.progress(3, 'He');
    feed.progress(3, 'Hello');
    expect(rows()).toMatchObject([{ status: 'live', text: 'Hello', msgId: 3 }]);
    feed.message(3, 'Hello there');
    expect(rows()).toMatchObject([{ status: 'verified', text: 'Hello there', count: 1, msgId: 3 }]);
    expect(feed.live).toBeNull();
  });

  it('adds a message that had no progress as a new verified row', () => {
    const { feed, rows } = setup();
    feed.message(1, 'Hi');
    expect(rows()).toMatchObject([{ status: 'verified', text: 'Hi', count: 1 }]);
  });

  it('counts a repeat (same msgId and text) on the last verified row, without a live row', () => {
    const { feed, rows } = setup();
    feed.message(3, 'Hello');
    feed.progress(3, 'Hel'); // the next pass streaming in
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ repeating: true });
    feed.message(3, 'Hello');
    feed.message(3, 'Hello');
    expect(rows()).toMatchObject([{ status: 'verified', text: 'Hello', count: 3, repeating: false }]);
  });

  it('treats the same text under a new msgId as a new message', () => {
    const { feed, rows } = setup();
    feed.message(3, 'Hello');
    feed.progress(4, 'Hel');
    feed.message(4, 'Hello');
    expect(rows()).toMatchObject([
      { msgId: 3, count: 1 },
      { msgId: 4, count: 1, status: 'verified' },
    ]);
  });

  it('streams a different message under the same msgId into a live row', () => {
    const { feed, rows } = setup();
    feed.message(3, 'Hello');
    feed.progress(3, 'Bye');
    expect(rows()).toMatchObject([{ text: 'Hello' }, { status: 'live', text: 'Bye' }]);
  });

  it('fails the live row on an error only once no lane is still reading', () => {
    const { feed, rows } = setup();
    feed.progress(2, 'Half a mess');
    feed.error('crc', true); // one light garbled, others still reading
    expect(rows()).toMatchObject([{ status: 'live' }]);
    feed.sources(true);
    expect(rows()).toMatchObject([{ status: 'live' }]);
    feed.sources(false); // the others stopped too: the attempt can't complete
    expect(rows()).toMatchObject([{ status: 'failed', reason: 'garbled', text: 'Half a mess' }]);
    expect(feed.live).toBeNull();
  });

  it('fails the live row at once when nothing else is reading', () => {
    const { feed, rows } = setup();
    feed.progress(2, 'Half');
    expect(feed.error('lost', false)).toBe(true);
    expect(rows()).toMatchObject([{ status: 'failed', reason: 'lost' }]);
  });

  it('ignores errors without a live row, and forgets a pending error once the message completes', () => {
    const { feed, rows } = setup();
    expect(feed.error('lost', false)).toBe(false);
    feed.progress(2, 'Al');
    feed.error('crc', true);
    feed.message(2, 'All good');
    feed.progress(5, 'Ne');
    feed.sources(false);
    expect(rows()).toMatchObject([{ status: 'verified' }, { status: 'live', text: 'Ne' }]);
  });

  it('abandons a live row when progress for another message starts', () => {
    const { feed, rows } = setup();
    feed.progress(2, 'Old');
    feed.progress(3, 'New');
    expect(rows()).toMatchObject([{ status: 'failed', reason: 'lost', text: 'Old' }, { status: 'live', text: 'New' }]);
  });

  it('removes rows and keeps at most `limit` rows', () => {
    const feed = new Feed(() => {}, 3);
    for (let i = 0; i < 5; i++) feed.message(i, `m${i}`);
    expect(feed.rows.map((r) => r.text)).toEqual(['m2', 'm3', 'm4']);
    feed.remove(feed.rows[0].id);
    expect(feed.rows.map((r) => r.text)).toEqual(['m3', 'm4']);
    expect(feed.verifiedCount).toBe(2);
  });

  it('reports each changed row to the listener', () => {
    const { feed, seen } = setup();
    feed.progress(1, 'a');
    feed.message(1, 'ab');
    expect([...seen.values()]).toMatchObject([{ status: 'verified', text: 'ab' }]);
  });
});
