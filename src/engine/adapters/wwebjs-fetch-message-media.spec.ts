import type { Client, Message } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { inboundMediaConcurrency } from './inbound-media-cap';

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
  return { messaging: new WwebjsMessaging(host), client, capInboundMediaFor, host };
}

const mediaMessage = (id = SERIALIZED) =>
  ({ hasMedia: true, id: { _serialized: id, id: id.split('_')[2] } }) as unknown as Message;

describe('WwebjsMessaging.fetchMessageMedia', () => {
  const saved = process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
  const savedMaxBytes = process.env.MEDIA_DOWNLOAD_MAX_BYTES;
  afterEach(() => {
    jest.useRealTimers();
    if (saved === undefined) delete process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
    else process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = saved;
    if (savedMaxBytes === undefined) delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    else process.env.MEDIA_DOWNLOAD_MAX_BYTES = savedMaxBytes;
  });

  /** fetchMessageMedia wired to the production capInboundMediaFor of a fresh adapter. */
  const throughAdapter = () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    const internals = adapter as unknown as { capInboundMediaFor: WwebjsEngineHost['capInboundMediaFor'] };
    return setup({ cap: jest.fn((m: Message, o?: number, d?: number) => internals.capInboundMediaFor(m, o, d)) });
  };

  it('looks a serialized id up with getMessageById and runs the capped arrival download', async () => {
    const msg = mediaMessage();
    const { messaging, client, capInboundMediaFor } = setup({ byId: msg });
    await expect(messaging.fetchMessageMedia(CHAT, SERIALIZED)).resolves.toEqual(ENVELOPE);
    expect(client.getMessageById).toHaveBeenCalledWith(SERIALIZED);
    expect(client.getChatById).not.toHaveBeenCalled();
    expect(capInboundMediaFor).toHaveBeenCalledWith(msg, undefined, expect.any(Number));
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
    const { messaging, client, capInboundMediaFor } = setup();
    client.getMessageById.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(msg), 700)));
    const started = Date.now();
    const settled = messaging.fetchMessageMedia(CHAT, SERIALIZED);
    await jest.advanceTimersByTimeAsync(700);
    await expect(settled).resolves.toEqual(ENVELOPE);
    // The download is handed the deadline the lookup started, not a fresh one.
    expect(capInboundMediaFor).toHaveBeenCalledWith(msg, undefined, started + 1000);
  });

  it('answers 503 when puppeteer protocolTimeout fails the lookup first, without reporting a page death', async () => {
    const reportIfPageTransportError = jest.fn();
    const { messaging, client, host } = setup();
    Object.assign(host, { reportIfPageTransportError });
    client.getMessageById.mockRejectedValue(
      new Error("Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls"),
    );
    await expect(messaging.fetchMessageMedia(CHAT, SERIALIZED)).rejects.toBeInstanceOf(EngineTransportError);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  // Through the production capInboundMediaFor and session limiter: a slot freed after the caller
  // already got its 503 must not start the abandoned download.
  it('never starts a queued download once the shared deadline has passed', async () => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '200';
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    const internals = adapter as unknown as {
      inboundLimiter: ConcurrencyLimiter;
      capInboundMediaFor: WwebjsEngineHost['capInboundMediaFor'];
    };
    const holders: Array<() => void> = [];
    for (let i = 0; i < inboundMediaConcurrency(); i++) {
      void internals.inboundLimiter.run(() => new Promise<void>(resolve => holders.push(resolve)));
    }
    const downloadMedia = jest.fn().mockResolvedValue({ mimetype: 'image/jpeg', data: 'SlBFRw==' });
    const msg = { hasMedia: true, id: { _serialized: SERIALIZED }, _data: { size: 4 }, downloadMedia };
    const { messaging, client } = setup({
      cap: jest.fn((m: Message, o?: number, d?: number) => internals.capInboundMediaFor(m, o, d)),
    });
    client.getMessageById.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(msg), 120)));
    await expect(messaging.fetchMessageMedia(CHAT, SERIALIZED)).rejects.toBeInstanceOf(EngineTransportError);
    // Every slot was held, so admit the queued task only now, after the caller's 503.
    for (const release of holders) release();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  // A lookup that answers in the millisecond the deadline was taken admits the download at once, so
  // the download's own MEDIA_DOWNLOAD_TIMEOUT_MS timer and the shared deadline expire in the same
  // tick. A download still pending then missed the deadline: 503, never the omitted marker the
  // caller reads as "this message has no media" (404).
  it('answers 503 when a stalled download and the shared deadline expire in the same tick', async () => {
    jest.useFakeTimers();
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '40';
    let finish: (media: { mimetype: string; data: string }) => void = () => undefined;
    const downloadMedia = jest.fn(() => new Promise<{ mimetype: string; data: string }>(resolve => (finish = resolve)));
    const msg = { hasMedia: true, id: { _serialized: SERIALIZED }, _data: { size: 4 }, downloadMedia };
    const { messaging, client } = throughAdapter();
    client.getMessageById.mockResolvedValue(msg);
    const settled = expect(messaging.fetchMessageMedia(CHAT, SERIALIZED)).rejects.toBeInstanceOf(EngineTransportError);
    await jest.advanceTimersByTimeAsync(40);
    await settled;
    expect(downloadMedia).toHaveBeenCalledTimes(1);
    // Let the late download settle so it hands its slot back.
    finish({ mimetype: 'image/jpeg', data: 'SlBFRw==' });
    await jest.advanceTimersByTimeAsync(0);
  });

  // Media over MEDIA_DOWNLOAD_MAX_BYTES is not coming back on a retry: the omitted marker (404), not 503.
  it.each([
    ['declares a size over the cap', 64, 'SlBFRw=='],
    ['downloads over the cap', 4, Buffer.alloc(64).toString('base64')],
  ])('resolves the omitted marker for media that %s', async (_label, declared, data) => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '16';
    const downloadMedia = jest.fn().mockResolvedValue({ mimetype: 'image/jpeg', data });
    const msg = { hasMedia: true, id: { _serialized: SERIALIZED }, _data: { size: declared }, downloadMedia };
    const { messaging, client } = throughAdapter();
    client.getMessageById.mockResolvedValue(msg);
    await expect(messaging.fetchMessageMedia(CHAT, SERIALIZED)).resolves.toEqual(
      expect.objectContaining({ omitted: true }),
    );
  });
});
