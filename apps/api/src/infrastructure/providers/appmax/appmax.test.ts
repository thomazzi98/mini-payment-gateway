import { describe, expect, it } from 'vitest';
import {
  APPMAX_ORDER_STATUSES,
  APPMAX_PIX_WEBHOOK_EVENTS,
  isAppmaxOrderStatus,
  lifecycleForOrderStatus,
  requiresProviderRead,
} from './appmax-mappings.js';
import {
  normalizePixResponse,
  parseAppmaxTimestamp,
  readOrderReference,
  UnreadableAppmaxPixResponseError,
} from './appmax-pix-response.js';

describe('translating Appmax order statuses', () => {
  it('maps every documented status to a lifecycle the gateway understands', () => {
    // Totality matters: a status Appmax documents but we forgot would fall through
    // to `unknown` and strand the payment.
    for (const status of APPMAX_ORDER_STATUSES) {
      expect(lifecycleForOrderStatus(status)).not.toBe('unknown');
    }
  });

  it('treats both approved states as paid', () => {
    expect(lifecycleForOrderStatus('aprovado')).toBe('paid');
    expect(lifecycleForOrderStatus('integrado')).toBe('paid');
  });

  it('treats a paid order still awaiting integration as paid', () => {
    // The money is held either way; Appmax's downstream integration is not our
    // concern and must not make a funded payment look unfunded.
    expect(lifecycleForOrderStatus('pendente_integracao')).toBe('paid');
    expect(lifecycleForOrderStatus('pendente_integracao_em_analise')).toBe('paid');
  });

  it('does not treat a card authorization as money in hand', () => {
    expect(lifecycleForOrderStatus('autorizado')).toBe('awaiting_payment');
  });

  it('maps every chargeback state to chargeback rather than guessing the outcome', () => {
    for (const status of [
      'chargeback_em_tratativa',
      'chargeback_em_disputa',
      'chargeback_perdido',
      'chargeback_vencido',
    ] as const) {
      expect(lifecycleForOrderStatus(status)).toBe('chargeback');
    }
  });

  it('maps an unrecognised status to unknown rather than to pending', () => {
    // The legacy system defaulted unfamiliar statuses to "pending", which turned
    // every status the provider added afterwards into a payment that waited
    // forever. Unknown is surfaced; pending is silent.
    for (const impostor of ['aprovada', 'APROVADO', 'settled', '', undefined, null, 42]) {
      expect(lifecycleForOrderStatus(impostor)).toBe('unknown');
    }
  });

  it('recognises only exact status strings', () => {
    expect(isAppmaxOrderStatus('aprovado')).toBe(true);
    expect(isAppmaxOrderStatus('Aprovado')).toBe(false);
    expect(isAppmaxOrderStatus(' aprovado ')).toBe(false);
  });
});

describe('deciding whether a webhook is worth a read', () => {
  it('reads on every event that could change what we believe', () => {
    const readable = APPMAX_PIX_WEBHOOK_EVENTS.filter(
      (candidate) => candidate !== 'order_pix_created',
    );
    for (const event of readable) {
      expect(requiresProviderRead(event)).toBe(true);
    }
  });

  it('does not read on an event that only confirms what the create call told us', () => {
    expect(requiresProviderRead('order_pix_created')).toBe(false);
  });

  it('reads on an event it has never seen before', () => {
    // Appmax documents forty events and may add more. Ignoring an unfamiliar one
    // risks missing a payment; reading costs one API call.
    expect(requiresProviderRead('order_something_new')).toBe(true);
    expect(requiresProviderRead(undefined)).toBe(true);
  });
});

describe('reading a Pix instrument out of a response', () => {
  const CODE = '00020126360014BR.GOV.BCB.PIX0114+55619999999996304ABCD';

  it('reads the data.pix shape', () => {
    const result = normalizePixResponse({
      data: { pix: { emv_code: CODE, qr_code: 'AAAA', expires_at: '2026-09-09 15:30:00' } },
    });

    expect(result.instrument.copyAndPasteCode).toBe(CODE);
    expect(result.shape).toBe('data.pix');
  });

  it('reads the data.payment shape, which the same vendor also documents', () => {
    const result = normalizePixResponse({
      data: {
        payment: { pix_emv: CODE, pix_qrcode: 'AAAA', pix_expiration_date: '2026-09-09 15:30:00' },
      },
    });

    expect(result.instrument.copyAndPasteCode).toBe(CODE);
    expect(result.shape).toBe('data.payment');
  });

  it('reports a mixed response, so a change on their side shows up in telemetry', () => {
    const result = normalizePixResponse({
      data: { pix: { emv_code: CODE }, payment: { pix_emv: CODE } },
    });

    expect(result.shape).toBe('mixed');
  });

  it('adds the data URI prefix when the QR image arrives without one', () => {
    // Documented both ways. A raw base64 blob in an img src renders nothing.
    const result = normalizePixResponse({ data: { pix: { emv_code: CODE, qr_code: 'AAAA' } } });
    expect(result.instrument.qrCodeImageDataUri).toBe('data:image/png;base64,AAAA');
  });

  it('leaves an already-prefixed data URI alone', () => {
    const prefixed = 'data:image/png;base64,AAAA';
    const result = normalizePixResponse({
      data: { pix: { emv_code: CODE, qr_code: prefixed } },
    });
    expect(result.instrument.qrCodeImageDataUri).toBe(prefixed);
  });

  it('refuses a response carrying no code in any documented location', () => {
    // Inventing a value here would hand a customer nothing to pay while the
    // gateway believed the instrument was live.
    for (const body of [
      {},
      { data: {} },
      { data: { pix: {} } },
      { data: { pix: { emv_code: '' } } },
      { data: { pix: { emv_code: ' '.repeat(3) } } },
      { data: { payment: { pix_emv: null } } },
      null,
      'not an object',
    ]) {
      expect(() => normalizePixResponse(body)).toThrow(UnreadableAppmaxPixResponseError);
    }
  });

  it('tolerates a missing QR image and a missing expiry', () => {
    // The copy-and-paste code alone is payable; the rest is convenience.
    const result = normalizePixResponse({ data: { pix: { emv_code: CODE } } });

    expect(result.instrument.copyAndPasteCode).toBe(CODE);
    expect(result.instrument.qrCodeImageDataUri).toBeUndefined();
    expect(result.instrument.expiresAt).toBeUndefined();
  });
});

describe('reading Appmax timestamps', () => {
  it('reads a naive timestamp as Brazilian rather than as UTC', () => {
    // Reading it as UTC would place expiry three hours early and expire codes
    // that are still live.
    const parsed = parseAppmaxTimestamp('2026-09-09 15:30:00');
    expect(parsed?.toISOString()).toBe('2026-09-09T18:30:00.000Z');
  });

  it('accepts an ISO timestamp that already carries a zone', () => {
    const parsed = parseAppmaxTimestamp('2026-09-09T15:30:00Z');
    expect(parsed?.toISOString()).toBe('2026-09-09T15:30:00.000Z');
  });

  it('returns undefined for something unparseable instead of an invalid date', () => {
    for (const value of ['', 'tomorrow', '0000-00-00 00:00:00', undefined]) {
      expect(parseAppmaxTimestamp(value)).toBeUndefined();
    }
  });
});

describe('reading the correlation reference', () => {
  it('reads a numeric order identifier as a string', () => {
    expect(readOrderReference({ data: { order: { id: 3531 } } })).toBe('3531');
  });

  it('reads a string order identifier', () => {
    expect(readOrderReference({ data: { order: { id: 'abc-1' } } })).toBe('abc-1');
  });

  it('falls back to a top-level order_id', () => {
    expect(readOrderReference({ data: { order_id: 42 } })).toBe('42');
  });

  it('returns undefined when there is nothing to correlate on', () => {
    for (const body of [{}, { data: {} }, { data: { order: {} } }, null]) {
      expect(readOrderReference(body)).toBeUndefined();
    }
  });
});
