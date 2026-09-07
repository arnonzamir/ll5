import { describe, it, expect } from 'vitest';
import { messageText } from '../tools/read-messages.js';

describe('messageText (2026-09-07: read_messages returned empty content for forwards/media)', () => {
  it('reads plain and extended text', () => {
    expect(messageText({ conversation: 'hi' })).toBe('hi');
    expect(messageText({ extendedTextMessage: { text: 'forwarded advert' } })).toBe('forwarded advert');
  });
  it('unwraps ephemeral / view-once wrappers', () => {
    expect(messageText({ ephemeralMessage: { message: { conversation: 'gone soon' } } })).toBe('gone soon');
    expect(messageText({ viewOnceMessageV2: { message: { imageMessage: { caption: 'look' } } } })).toBe('look');
  });
  it('captions win, placeholders otherwise', () => {
    expect(messageText({ imageMessage: { caption: 'park' } })).toBe('park');
    expect(messageText({ imageMessage: {} })).toBe('[image]');
    expect(messageText({ audioMessage: {} })).toBe('[voice note]');
    expect(messageText({ documentMessage: { fileName: 'route.pdf' } })).toBe('route.pdf');
    expect(messageText({ reactionMessage: { text: '👍' } })).toBe('[reaction 👍]');
    expect(messageText(undefined)).toBe('');
  });
});
