import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64Of, ZeptoMailer } from './mail';
import { vaultArchiveMail, vaultResetNoticeMail } from './vault-archive-mail';

/**
 * The archive mail and the attachment it carries: what the body says first,
 * what it never says, and the bytes ZeptoMail is handed.
 */

const file = {
  fileName: 'xecret-vault-archive-2026-10-12.zip',
  bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
};
const params = {
  to: 'owner@example.com',
  part: 1,
  parts: 1,
  file,
  retainedUntil: new Date('2026-10-19T09:30:00.000Z'),
  origin: 'https://xecret.playxoft.com',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('vaultArchiveMail', () => {
  it('leads with the offline-attack warning, before what the file is for', () => {
    const mail = vaultArchiveMail(params);

    expect(mail.text.indexOf('READ THIS FIRST')).toBeGreaterThan(-1);
    expect(mail.text.indexOf('READ THIS FIRST')).toBeLessThan(
      mail.text.indexOf('To open the attachment'),
    );
    expect(mail.text).toMatch(/no rate limit and no lockout/);
    expect(mail.html).toContain('Read this first');
  });

  it('states the seven-day window and where to recover', () => {
    const mail = vaultArchiveMail(params);
    expect(mail.text).toContain('Until 2026-10-19 at 09:30 UTC');
    expect(mail.text).toContain('https://xecret.playxoft.com/app/settings/security');
    expect(mail.text).toContain('xecret vault open-archive');
  });

  it('attaches the zip and nothing else', () => {
    expect(vaultArchiveMail(params).attachments).toEqual([
      { name: file.fileName, mimeType: 'application/zip', content: file.bytes },
    ]);
  });

  it('numbers the parts of a split archive', () => {
    const mail = vaultArchiveMail({ ...params, part: 2, parts: 3 });
    expect(mail.subject).toBe('Your xecret vault archive, part 2 of 3');
    expect(mail.text).toContain('This is part 2 of 3.');
  });
});

describe('vaultResetNoticeMail', () => {
  it('says no archive is attached, and attaches none', () => {
    const mail = vaultResetNoticeMail({
      to: 'owner@example.com',
      retainedUntil: params.retainedUntil,
      origin: params.origin,
    });
    expect(mail.text).toContain('no');
    expect(mail.text).toContain('archive is attached');
    expect(mail.attachments).toBeUndefined();
  });
});

describe('base64Of', () => {
  it('matches the platform encoding across chunk boundaries', () => {
    for (const length of [0, 1, 2, 3, 24 * 1024 - 1, 24 * 1024, 24 * 1024 + 1, 100_000]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
      expect(base64Of(bytes), String(length)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('ZeptoMailer', () => {
  it('sends attachments as name, mime_type and base64 content', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetch);

    await new ZeptoMailer({
      token: 't',
      fromAddress: 'no-reply@example.com',
      fromName: 'xecret',
      apiUrl: 'https://api.zeptomail.com/v1.1/email',
    }).send(vaultArchiveMail(params));

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { attachments: unknown };
    expect(body.attachments).toEqual([
      {
        name: file.fileName,
        mime_type: 'application/zip',
        content: Buffer.from(file.bytes).toString('base64'),
      },
    ]);
  });

  it('sends no attachments field for a mail without any', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetch);

    await new ZeptoMailer({
      token: 't',
      fromAddress: 'no-reply@example.com',
      fromName: 'xecret',
      apiUrl: 'https://api.zeptomail.com/v1.1/email',
    }).send(
      vaultResetNoticeMail({
        to: 'a@example.com',
        retainedUntil: params.retainedUntil,
        origin: params.origin,
      }),
    );

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('attachments');
  });
});
