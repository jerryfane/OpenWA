jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applyGlobalValidation } from '../src/config/app-validation';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';
import { Session } from '../src/modules/session/entities/session.entity';
import { MessageProjector } from '../src/modules/session/message-projector.service';
import { WebhookService } from '../src/modules/webhook/webhook.service';
import { EngineRegistry } from '../src/engine/engine-registry.service';
import type { IWhatsAppEngine, IncomingMessage } from '../src/engine/interfaces/whatsapp-engine.interface';
import { EventEmitter } from 'node:events';
import type { Client } from 'whatsapp-web.js';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../src/common/services/logger.service';
import { Message } from '../src/modules/message/entities/message.entity';
import { BaileysHistory, BaileysHistoryHost } from '../src/engine/adapters/baileys-history';
import { registerWwebjsMessageEvents } from '../src/engine/adapters/wwebjs-message-events';
import type { WwebjsEngineHost } from '../src/engine/adapters/wwebjs-host';
import { persistHistoryMessages } from '../src/modules/session/message-history-projector';

describe('Location history (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('retains a location pin in HTTP history after inbound persistence', async () => {
    const sessions = app.get<Repository<Session>>(getRepositoryToken(Session, 'data'));
    const session = await sessions.save(sessions.create({ name: 'location-history' }));
    const key = await app.get(AuthService).createApiKey({ name: 'location-history', role: ApiKeyRole.OPERATOR });
    const engine = { destroy: jest.fn().mockResolvedValue(undefined) } as unknown as IWhatsAppEngine;
    app.get(EngineRegistry).set(session.id, engine);
    const location = {
      latitude: 0,
      longitude: -73.75,
      description: 'Synthetic meeting point',
      address: 'Example street',
      url: 'https://example.com/map',
    };
    const incoming = {
      id: 'false_15550000001@c.us_LOCATION',
      from: '15550000001@c.us',
      to: '15550000002@c.us',
      chatId: '15550000001@c.us',
      body: '',
      type: 'location',
      timestamp: 1792250000,
      fromMe: false,
      isGroup: false,
      location,
    } as IncomingMessage;
    let persisted!: () => void;
    const completion = new Promise<void>(resolve => {
      persisted = resolve;
    });
    const dispatch = jest.spyOn(app.get(WebhookService), 'dispatch').mockImplementation((id, event) => {
      if (id === session.id && event === 'message.received') persisted();
      return Promise.resolve();
    });
    try {
      app.get(MessageProjector).handleInboundMessage(session.id, engine, incoming);
      await completion;
      // Read through the authenticated production route and real SQLite JSON column,
      // not the still-intact webhook payload or an echo from a mocked repository.
      const response = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/messages`)
        .set('X-API-Key', key.rawKey)
        .expect(200);
      const body = response.body as {
        messages: Array<{ waMessageId: string; metadata?: { location?: typeof location } }>;
      };
      const stored = body.messages.find(message => message.waMessageId === incoming.id);
      expect(stored?.metadata?.location).toEqual(location);
    } finally {
      dispatch.mockRestore();
    }
  });

  async function fixture(name: string) {
    const sessions = app.get<Repository<Session>>(getRepositoryToken(Session, 'data'));
    const session = await sessions.save(sessions.create({ name }));
    const key = await app.get(AuthService).createApiKey({ name, role: ApiKeyRole.OPERATOR });
    const engine = {
      destroy: jest.fn().mockResolvedValue(undefined),
      getInfo: () => ({ status: 'connected', isConnected: true }),
      sendLocationMessage: jest.fn().mockResolvedValue({ id: 'API-LOCATION', timestamp: 1792250000 }),
    } as unknown as IWhatsAppEngine;
    app.get(EngineRegistry).set(session.id, engine);
    return { session, key, engine };
  }

  async function storedLocation(sessionId: string, key: string, waId: string) {
    const response = await request(app.getHttpServer())
      .get(`/api/sessions/${sessionId}/messages`)
      .set('X-API-Key', key)
      .expect(200);
    const body = response.body as { messages: Array<{ waMessageId: string; metadata?: { location?: unknown } }> };
    return body.messages.find(message => message.waMessageId === waId)?.metadata?.location;
  }

  it('retains coordinates from a raw Baileys backfill through HTTP history', async () => {
    const { session, key } = await fixture('location-backfill');
    const logger = await app.resolve(LoggerService);
    let persisted: Promise<void> | undefined;
    const host = {
      loadLib: () =>
        Promise.resolve({
          normalizeMessageContent: (content: unknown) => content,
          getContentType: () => 'locationMessage',
        }),
      recordMessage: jest.fn(),
      toNeutralJid: (jid: string) => jid.replace('@s.whatsapp.net', '@c.us'),
      normalizedSelfJid: () => '15550000002@c.us',
      extractEphemeralDuration: () => undefined,
      getOnHistoryMessages: () => (messages: IncomingMessage[]) => {
        persisted = persistHistoryMessages(
          app.get<Repository<Message>>(getRepositoryToken(Message, 'data')),
          app.get(ConfigService),
          session.id,
          messages,
          logger,
          () => true,
        );
      },
    } as unknown as BaileysHistoryHost;
    await new BaileysHistory(host).captureHistoryMessages([
      {
        key: { id: 'HISTORY-LOCATION', remoteJid: '15550000001@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { locationMessage: { degreesLatitude: 0, degreesLongitude: -73.75, name: 'Backfilled pin' } },
      },
    ]);
    expect(persisted).toBeDefined();
    await persisted;
    expect(await storedLocation(session.id, key.rawKey, 'HISTORY-LOCATION')).toMatchObject({
      latitude: 0,
      longitude: -73.75,
      description: 'Backfilled pin',
    });
  });

  it('retains a phone-composed web-client location after its own-send event', async () => {
    const { session, key, engine } = await fixture('location-own-send');
    const client = new EventEmitter();
    const host = {
      logger: await app.resolve(LoggerService),
      getCallbacks: () => ({
        onMessageCreate: (message: IncomingMessage) =>
          app.get(MessageProjector).handleOwnSendEcho(session.id, engine, message),
      }),
    } as unknown as WwebjsEngineHost;
    registerWwebjsMessageEvents(client as unknown as Client, host);
    let complete!: () => void;
    const persisted = new Promise<void>(resolve => {
      complete = resolve;
    });
    const dispatch = jest.spyOn(app.get(WebhookService), 'dispatch').mockImplementation((id, event) => {
      if (id === session.id && event === 'message.sent') complete();
      return Promise.resolve();
    });
    try {
      client.emit('message_create', {
        id: { _serialized: 'PHONE-LOCATION' },
        from: '15550000002@c.us',
        to: '15550000001@c.us',
        body: '',
        type: 'location',
        timestamp: Math.floor(Date.now() / 1000),
        fromMe: true,
        location: { latitude: '0', longitude: '-73.75', description: 'Phone pin' },
      });
      await persisted;
      expect(await storedLocation(session.id, key.rawKey, 'PHONE-LOCATION')).toMatchObject({
        latitude: 0,
        longitude: -73.75,
        description: 'Phone pin',
      });
    } finally {
      dispatch.mockRestore();
    }
  });

  it('retains an API-sent location in authenticated HTTP history', async () => {
    const { session, key } = await fixture('location-api-send');
    await request(app.getHttpServer())
      .post(`/api/sessions/${session.id}/messages/send-location`)
      .set('X-API-Key', key.rawKey)
      .send({
        chatId: '15550000001@c.us',
        latitude: 0,
        longitude: -73.75,
        description: 'API pin',
        address: 'Example street',
      })
      .expect(201);
    expect(await storedLocation(session.id, key.rawKey, 'API-LOCATION')).toEqual({
      latitude: 0,
      longitude: -73.75,
      description: 'API pin',
      address: 'Example street',
    });
  });
});
