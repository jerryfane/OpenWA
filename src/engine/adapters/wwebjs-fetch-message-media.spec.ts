import type { Client, Message } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * fetchMessageMedia is the recovery path for a message whose arrival download failed: it looks the
 * message up again and runs the SAME capped download (capInboundMediaFor) arrival ran. The lookup is
 * a page call with no deadline of its own, so the lookup and the download share one
 * MEDIA_DOWNLOAD_TIMEOUT_MS, and missing it is a 503 the caller can retry, never a null it would
 * read as "the media is gone".
 */
const logger = createLogger('wwebjs-fetch-message-media.spec');
const CHAT = '628999@c.us';
const SERIALIZED = 'false_628999@c.us_ABC';
const ENVELOPE = { mimetype: 'image/jpeg', data: Buffer.from('JPEG').toString('base64') };

function setup(opts: { byId?: unknown; window?: unknown[]; cap?: jest.Mock } = {}) {
  const client = {
    getMessageById: jest.fn().mockResolvedValue(opts.byId ?? null),
    getChatById: jest.fn().mockResolvedValue({ fetchMessages: jest.fn().mockResolvedValue(opts.window ?? []) }),
  };
  const capInboundMediaFor = opts.cap ?? jest.fn().mockResolvedValue(ENVELOPE);
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    capInboundMediaFor,
    logger,
  } as unknown as WwebjsEngineHost;
  return { messaging: new WwebjsMessaging(host), client, capInboundMediaFor };
}

const mediaMessage = (id = SERIALIZED) =>
  ({ hasMedia: true, id: { _serialized: id, id: id.split('_')[2] } }) as unknown as Message;

describe('WwebjsMessaging.fetchMessageMedia', () => {
  const saved = process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
  afterEach(() => {
    jest.useRealTimers();
    if (saved === undefined) delete process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
    else process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = saved;
  });

  it('looks a serialized id up with getMessageById and runs the capped arrival download', async () => {
    const msg = mediaMessage();
    const { messaging, client, capInboundMediaFor } = setup({ byId: msg });
    await expect(messaging.fetchMessageMedia(CHAT, SERIALIZED)).resolves.toEqual(ENVELOPE);
    expect(client.getMessageById).toHaveBeenCalledWith(SERIALIZED);
    expect(client.getChatById).not.toHaveBeenCalled();
    expect(capInboundMediaFor).toHaveBeenCalledWith(msg);
  });

  it('passes the omitted marker through when the download fails again', async () => {
    const marker = { mimetype: 'image/jpeg', omitted: true, sizeBytes: 10 };
    const { messaging } = setup({ byId: mediaMessage(), cap: jest.fn().mockResolvedValue(marker) });
    await expect(messaging.fetchMessageMedia(CHAT, SERIALIZED)).resolves.toEqual(marker);
  });

  it('returns null for a message WhatsApp Web no longer has', async () => {
    const { messaging, capInboundMediaFor } = setup({ byId: null });
    await expect(messaging.fetchMessageMedia(CHAT, SERIALIZED)).resolves.toBeNull();
    expect(capInboundMediaFor).not.toHaveBeenCalled();
  });

  it('returns null for a message without media, without downloading', async () => {
    const { messaging, capInboundMediaFor } = setup({ byId: { hasMedia: false } });
    await expect(messaging.fetchMessageMedia(CHAT, SERIALIZED)).resolves.toBeNull();
    expect(capInboundMediaFor).not.toHaveBeenCalled();
  });

  // getMessageById throws page-side ("Invalid serialized message id") for any other shape.
  it('finds a bare id in the chat window instead of handing it to getMessageById', async () => {
    const msg = mediaMessage();
    const { messaging, client } = setup({ window: [msg] });
    await expect(messaging.fetchMessageMedia(CHAT, 'ABC')).resolves.toEqual(ENVELOPE);
    expect(client.getMessageById).not.toHaveBeenCalled();
    expect(client.getChatById).toHaveBeenCalledWith(CHAT);
  });

  it('returns null for a bare id outside the chat window', async () => {
    const { messaging } = setup({ window: [] });
    await expect(messaging.fetchMessageMedia(CHAT, 'ABC')).resolves.toBeNull();
  });

  it('answers 503 when the lookup outlives MEDIA_DOWNLOAD_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '1000';
    const { messaging, client, capInboundMediaFor } = setup();
    client.getMessageById.mockReturnValue(new Promise(() => undefined));
    const result = messaging.fetchMessageMedia(CHAT, SERIALIZED);
    const settled = expect(result).rejects.toBeInstanceOf(EngineTransportError);
    await jest.advanceTimersByTimeAsync(1000);
    await settled;
    expect(capInboundMediaFor).not.toHaveBeenCalled();
  });

  // One deadline for both steps: a lookup that took most of it leaves the download only the rest.
  it('bounds the lookup and the download by ONE deadline, not one each', async () => {
    jest.useFakeTimers();
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '1000';
    const msg = mediaMessage();
    const { messaging, client } = setup({ cap: jest.fn().mockReturnValue(new Promise(() => undefined)) });
    client.getMessageById.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(msg), 700)));
    let failedAt = -1;
    const started = Date.now();
    const settled = messaging.fetchMessageMedia(CHAT, SERIALIZED).catch((error: unknown) => {
      failedAt = Date.now() - started;
      return error;
    });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(settled).resolves.toBeInstanceOf(EngineTransportError);
    expect(failedAt).toBe(1000);
  });
});
