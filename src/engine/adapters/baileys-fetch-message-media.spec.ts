import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';

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
    inboundLimiter: new ConcurrencyLimiter(1),
  } as unknown as BaileysMessagingHost;
  return { messaging: new BaileysMessaging(host), getStoredMessage, mapMessage };
}

describe('BaileysMessaging.fetchMessageMedia', () => {
  it('re-runs the inbound mapper, download included, on the stored message', async () => {
    const { messaging, getStoredMessage, mapMessage } = setup(IMAGE, { media: ENVELOPE });
    await expect(messaging.fetchMessageMedia('628111@c.us', 'IMG-1')).resolves.toEqual(ENVELOPE);
    expect(getStoredMessage).toHaveBeenCalledWith('IMG-1');
    // No skipMediaDownload: the whole point is the download.
    expect(mapMessage).toHaveBeenCalledWith(IMAGE, 'imageMessage', { mediaDeadlineAt: expect.any(Number) as number });
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

/**
 * The post-merge review's smokes, through the production mapper (BaileysEvents.mapMessage): the
 * re-fetch must take the session's inbound slot like arrival does, and ONE MEDIA_DOWNLOAD_TIMEOUT_MS
 * covers the stored lookup and the download, with expiry a retryable 503, not the omitted marker.
 */
describe('BaileysMessaging.fetchMessageMedia through the real mapper', () => {
  const saved = process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
    else process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = saved;
  });

  const image = (id: string) =>
    ({
      key: { id, remoteJid: '628111@s.whatsapp.net', fromMe: false },
      message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 4 } },
    }) as unknown as WAMessage;

  function realSetup(downloadMediaMessage: jest.Mock, getStoredMessage: (id: string) => Promise<WAMessage | null>) {
    const lib = {
      normalizeMessageContent: (c: unknown) => c,
      extractMessageContent: (c: unknown) => c,
      getContentType: (c: Record<string, unknown> | undefined) => Object.keys(c ?? {})[0],
      downloadMediaMessage,
    };
    const inboundLimiter = new ConcurrencyLimiter(1);
    const events = new BaileysEvents({
      getSocket: () => ({ updateMediaMessage: jest.fn() }),
      getSocketOrNull: () => null,
      logger,
      loadLib: () => Promise.resolve(lib),
      getFetchDispatcher: () => undefined,
      toNeutralJid: (jid: string) => jid,
      normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
      inboundLimiter,
      toUnixSeconds: () => 0,
    } as unknown as BaileysEventsHost);
    const host = {
      ensureReady: jest.fn(),
      logger,
      loadLib: () => Promise.resolve(lib as never),
      getStoredMessage,
      wasDeletedForEveryone: () => false,
      mapMessage: (msg: WAMessage, ct: string | undefined, opts?: object) => events.mapMessage(msg, ct, opts),
      inboundLimiter,
    } as unknown as BaileysMessagingHost;
    return new BaileysMessaging(host);
  }

  it('holds the session inbound slot, so two re-fetches never download at once (INBOUND_MEDIA_CONCURRENCY=1)', async () => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '5000';
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const downloadMediaMessage = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active -= 1;
      return [Buffer.from('JPEG')];
    });
    const messaging = realSetup(downloadMediaMessage, id => Promise.resolve(image(id)));
    const fetches = Promise.all([
      messaging.fetchMessageMedia('628111@c.us', 'IMG-A'),
      messaging.fetchMessageMedia('628111@c.us', 'IMG-B'),
    ]);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
    releases.shift()?.();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(downloadMediaMessage).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await expect(fetches).resolves.toEqual([
      expect.objectContaining({ mimetype: 'image/jpeg' }),
      expect.objectContaining({ mimetype: 'image/jpeg' }),
    ]);
    expect(peak).toBe(1);
  });

  it('counts the stored lookup against the deadline: a lookup slower than it is a 503', async () => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '40';
    const downloadMediaMessage = jest.fn();
    const messaging = realSetup(
      downloadMediaMessage,
      id => new Promise(resolve => setTimeout(() => resolve(image(id)), 120)),
    );
    await expect(messaging.fetchMessageMedia('628111@c.us', 'IMG-SLOW')).rejects.toBeInstanceOf(EngineTransportError);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('answers a stalled download with a 503, not the omitted marker (404)', async () => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '40';
    const downloadMediaMessage = jest.fn(() => new Promise(() => undefined));
    const messaging = realSetup(downloadMediaMessage, id => Promise.resolve(image(id)));
    await expect(messaging.fetchMessageMedia('628111@c.us', 'IMG-STALL')).rejects.toBeInstanceOf(EngineTransportError);
  });
});
