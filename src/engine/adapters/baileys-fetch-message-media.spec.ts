import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { createLogger } from '../../common/services/logger.service';

/**
 * On Baileys the raw WAMessage stored on arrival still holds the media key and CDN path, so the
 * on-demand fetch re-runs the inbound mapper's capped download on it rather than wiring a second
 * download path.
 */
const logger = createLogger('baileys-fetch-message-media.spec');
const IMAGE = {
  key: { id: 'IMG-1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
  message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 4 } },
} as unknown as WAMessage;
const ENVELOPE = { mimetype: 'image/jpeg', data: Buffer.from('JPEG').toString('base64') };

function setup(stored: unknown, opts: { deleted?: boolean; media?: unknown } = {}) {
  const getStoredMessage = jest.fn().mockResolvedValue(stored);
  const mapMessage = jest.fn().mockResolvedValue({ id: 'IMG-1', media: opts.media });
  const host = {
    ensureReady: jest.fn(),
    logger,
    loadLib: () =>
      Promise.resolve({
        normalizeMessageContent: (c: unknown) => c,
        getContentType: (c: Record<string, unknown>) => Object.keys(c)[0],
      } as never),
    getStoredMessage,
    wasDeletedForEveryone: () => opts.deleted === true,
    mapMessage,
  } as unknown as BaileysMessagingHost;
  return { messaging: new BaileysMessaging(host), getStoredMessage, mapMessage };
}

describe('BaileysMessaging.fetchMessageMedia', () => {
  it('re-runs the inbound mapper, download included, on the stored message', async () => {
    const { messaging, getStoredMessage, mapMessage } = setup(IMAGE, { media: ENVELOPE });
    await expect(messaging.fetchMessageMedia('628111@c.us', 'IMG-1')).resolves.toEqual(ENVELOPE);
    expect(getStoredMessage).toHaveBeenCalledWith('IMG-1');
    // No skipMediaDownload: the whole point is the download.
    expect(mapMessage).toHaveBeenCalledWith(IMAGE, 'imageMessage');
  });

  it('returns null for a stored message without media', async () => {
    const { messaging } = setup(IMAGE, { media: undefined });
    await expect(messaging.fetchMessageMedia('628111@c.us', 'IMG-1')).resolves.toBeNull();
  });

  it.each([
    ['no message store (or the store lacks the id)', undefined, false],
    ['a stored copy whose content was removed by a delete', { key: IMAGE.key, message: null }, false],
    ['a message deleted for everyone', IMAGE, true],
  ])('returns null without downloading for %s', async (_label, stored, deleted) => {
    const { messaging, mapMessage } = setup(stored, { deleted, media: ENVELOPE });
    await expect(messaging.fetchMessageMedia('628111@c.us', 'IMG-1')).resolves.toBeNull();
    expect(mapMessage).not.toHaveBeenCalled();
  });
});
