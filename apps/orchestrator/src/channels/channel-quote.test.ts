import { describe, expect, it } from 'vitest';
import { withQuote } from './chat-format';
import { replyInfo } from './telegram.adapter';

describe('quote-replies', () => {
  it('replyInfo reads the replied-to message id and the quoted text (partial quote wins)', () => {
    expect(replyInfo({})).toEqual({});
    expect(replyInfo({ reply_to_message: { message_id: 42, text: 'the whole message' } })).toEqual({ replyToMessageId: '42', replyToText: 'the whole message' });
    expect(replyInfo({ reply_to_message: { message_id: 42, text: 'the whole message' }, quote: { text: 'whole' } })).toEqual({ replyToMessageId: '42', replyToText: 'whole' });
    expect(replyInfo({ reply_to_message: { message_id: 7, caption: 'a photo caption' } })).toEqual({ replyToMessageId: '7', replyToText: 'a photo caption' });
    expect(replyInfo({ reply_to_message: { message_id: 9 } })).toEqual({ replyToMessageId: '9' }); // a reply to a photo without text
  });
  it('withQuote puts the quoted words in front, trimmed', () => {
    expect(withQuote('ok, do it')).toBe('ok, do it');
    expect(withQuote('ok, do it', '  ')).toBe('ok, do it');
    expect(withQuote('ok, do it', 'Shall I   deploy?')).toBe('↩︎ Replying to «Shall I deploy?»\n\nok, do it');
    expect(withQuote('x', 'a'.repeat(600))).toContain('…»');
  });
});
