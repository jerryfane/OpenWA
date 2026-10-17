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
    const engine = {} as IWhatsAppEngine;
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
});
