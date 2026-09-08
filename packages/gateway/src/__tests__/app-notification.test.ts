import { describe, it, expect } from 'vitest';
import {
  classifyNotificationPackage,
  notificationDedupeKey,
  notificationDocId,
  resolveNotificationRouting,
  buildNotificationDoc,
  renderImmediateNotification,
  renderNotificationBurst,
  decideNotificationDelivery,
  IMMEDIATE_MAX_PER_HOUR,
} from '../processors/app-notification.js';
import { newCostGuardState, noteBurstFlushed } from '../connectors/cost-guard.js';
import type { PushAppNotificationItem } from '../types/index.js';

const T0 = Date.UTC(2026, 8, 8, 12, 0, 0);

function item(over: Partial<PushAppNotificationItem> = {}): PushAppNotificationItem {
  return {
    type: 'app_notification',
    package: 'com.wolt.android',
    app_label: 'Wolt',
    title: 'Order on the way',
    text: 'Your courier is 5 minutes away',
    big_text: null,
    post_time: '2026-09-08T12:00:00+03:00',
    key: '0|com.wolt.android|1001|null|10234',
    ...over,
  };
}

describe('app_notification package routing (pure)', () => {
  it('catalog connector packages keep the connector path', () => {
    expect(classifyNotificationPackage('com.onoapps.cal4u')).toBe('connector');
  });
  it('IM packages are dropped (the message path carries them)', () => {
    expect(classifyNotificationPackage('com.whatsapp')).toBe('im');
    expect(classifyNotificationPackage('org.telegram.messenger')).toBe('im');
    expect(classifyNotificationPackage('com.google.android.gm')).toBe('im');
  });
  it('everything else is an app notification', () => {
    expect(classifyNotificationPackage('com.wolt.android')).toBe('app');
    expect(classifyNotificationPackage('com.google.android.apps.maps')).toBe('app');
  });
});

describe('dedupe key + removal merge', () => {
  it('uses the Android notification key when present — an update and its removal share the id', () => {
    const posted = item();
    const updated = item({ text: 'Your courier is 1 minute away' });
    const removed = item({ title: null, text: null, removed: true });
    const k = notificationDedupeKey(posted);
    expect(k).toBe('com.wolt.android:0|com.wolt.android|1001|null|10234');
    expect(notificationDedupeKey(updated)).toBe(k);
    expect(notificationDedupeKey(removed)).toBe(k);
    expect(notificationDocId('u1', k)).toBe(notificationDocId('u1', notificationDedupeKey(removed)));
    expect(notificationDocId('u1', k)).not.toBe(notificationDocId('u2', k)); // tenant-scoped
  });

  it('falls back to a content hash without a key; different post_time = different notification', () => {
    const a = item({ key: null });
    const b = item({ key: null, post_time: '2026-09-08T12:05:00+03:00' });
    expect(notificationDedupeKey(a)).toMatch(/^com\.wolt\.android:h:[0-9a-f]{24}$/);
    expect(notificationDedupeKey(a)).toBe(notificationDedupeKey(item({ key: null })));
    expect(notificationDedupeKey(a)).not.toBe(notificationDedupeKey(b));
  });

  it('builds a stored doc with posted_at from `when` (else post_time) and removed_at null', () => {
    const d = buildNotificationDoc('u1', item({ when: '2026-09-08T11:59:30+03:00', ongoing: false, category: 'status' }), '2026-09-08T09:00:05.000Z');
    expect(d).toMatchObject({
      user_id: 'u1', package: 'com.wolt.android', app_label: 'Wolt', title: 'Order on the way',
      category: 'status', ongoing: false, posted_at: '2026-09-08T11:59:30+03:00', received_at: '2026-09-08T09:00:05.000Z', removed_at: null,
    });
    expect(d.dedupe_key).toBe(notificationDedupeKey(item()));
    expect(buildNotificationDoc('u1', item(), 'x').posted_at).toBe('2026-09-08T12:00:00+03:00');
  });
});

describe('routing decision + cost guard', () => {
  it('defaults to batch; only immediate / ignore are honoured', () => {
    expect(resolveNotificationRouting(undefined, 'com.wolt.android')).toBe('batch');
    expect(resolveNotificationRouting({}, 'com.wolt.android')).toBe('batch');
    expect(resolveNotificationRouting({ 'com.wolt.android': 'immediate' }, 'com.wolt.android')).toBe('immediate');
    expect(resolveNotificationRouting({ 'com.wolt.android': 'ignore' }, 'com.wolt.android')).toBe('ignore');
    expect(resolveNotificationRouting({ 'com.wolt.android': 'loud' }, 'com.wolt.android')).toBe('batch');
  });

  it('ignore = not stored; batch = stored, no message', () => {
    const g = newCostGuardState(T0);
    expect(decideNotificationDelivery('ignore', item(), g, T0)).toBe('skip');
    expect(decideNotificationDelivery('batch', item(), g, T0)).toBe('store');
    expect(g.immediateThisHour).toBe(0);
  });

  it('immediate: 3 per package per hour, then coalesce, then stored only after the burst flushed', () => {
    const g = newCostGuardState(T0);
    for (let i = 0; i < IMMEDIATE_MAX_PER_HOUR; i++) {
      expect(decideNotificationDelivery('immediate', item(), g, T0 + i)).toBe('system_message');
    }
    expect(decideNotificationDelivery('immediate', item(), g, T0 + 10)).toBe('coalesce');
    expect(decideNotificationDelivery('immediate', item(), g, T0 + 11)).toBe('coalesce');
    noteBurstFlushed(g, T0 + 12);
    expect(decideNotificationDelivery('immediate', item(), g, T0 + 13)).toBe('store');
    // next hour resets
    expect(decideNotificationDelivery('immediate', item(), g, T0 + 3_600_000)).toBe('system_message');
  });

  it('immediate never fires for removals or ongoing notifications, and they do not consume the budget', () => {
    const g = newCostGuardState(T0);
    expect(decideNotificationDelivery('immediate', item({ removed: true }), g, T0)).toBe('store');
    expect(decideNotificationDelivery('immediate', item({ ongoing: true }), g, T0)).toBe('store');
    expect(g.immediateThisHour).toBe(0);
  });
});

describe('rendering', () => {
  it('immediate line is [Notification] <app>: <title> — <text>, tolerant of a missing half', () => {
    expect(renderImmediateNotification(item())).toBe('[Notification] Wolt: Order on the way — Your courier is 5 minutes away');
    expect(renderImmediateNotification(item({ text: null }))).toBe('[Notification] Wolt: Order on the way');
    expect(renderImmediateNotification(item({ title: null }))).toBe('[Notification] Wolt: Your courier is 5 minutes away');
    expect(renderImmediateNotification(item({ app_label: null, title: null, text: null }))).toBe('[Notification] com.wolt.android: (no text)');
  });

  it('burst body lists every coalesced line under one header', () => {
    const body = renderNotificationBurst('Wolt', [
      { ts: T0, sender: 'Wolt', text: 'A — 1', mediaInfo: '', quotedInfo: '', fromMe: false },
      { ts: T0 + 1, sender: 'Wolt', text: 'B — 2', mediaInfo: '', quotedInfo: '', fromMe: false },
    ]);
    expect(body).toBe('[Notification] Wolt: 2 notifications in the last 15 min (rate cap reached):\n- A — 1\n- B — 2');
  });
});
