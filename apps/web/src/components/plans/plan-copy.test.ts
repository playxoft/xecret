import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api';
import {
  planName,
  planRefusalOf,
  reasonPrefixOf,
  upgradeSentence,
  withoutReasonPrefix,
} from './plan-copy';

describe('plan copy', () => {
  it('names a plan the way the pricing page does', () => {
    expect(planName('pro')).toBe('Pro');
    expect(planName('team')).toBe('Team');
    // An id this build does not know is shown as it is, never as `undefined`.
    expect(planName('galaxy')).toBe('galaxy');
    expect(planName('constructor')).toBe('constructor');
  });

  it('reads a plan refusal, and only a plan refusal', () => {
    const refusal = new ApiError({
      code: 'plan_limit',
      message: 'Promotion is not included in this plan.',
      status: 403,
      requestId: null,
      plan: {
        resource: 'environmentPromotion',
        limit: null,
        current: null,
        plan: 'free',
        upgradeTo: 'pro',
      },
    });
    expect(planRefusalOf(refusal)).toEqual({
      message: 'Promotion is not included in this plan.',
      plan: refusal.plan,
      upgradeTo: 'pro',
    });

    // A refusal whose block the client could not read is still a refusal.
    expect(
      planRefusalOf(
        new ApiError({ code: 'plan_limit', message: 'No.', status: 403, requestId: null }),
      )?.upgradeTo,
    ).toBeNull();

    expect(
      planRefusalOf(
        new ApiError({ code: 'forbidden', message: 'No.', status: 403, requestId: null }),
      ),
    ).toBeNull();
    expect(planRefusalOf(new Error('plan_limit'))).toBeNull();
  });

  it('says which plan unlocks a control, or that none does', () => {
    expect(upgradeSentence('Setting a parent', 'pro')).toBe('Setting a parent needs the Pro plan.');
    expect(upgradeSentence('Setting a parent', null)).toBe(
      'Setting a parent is not part of this organisation’s plan.',
    );
  });

  it('shows a prefixed refusal as the sentence after its prefix', () => {
    const message =
      'export_disabled: plaintext export is disabled for api/prod by its environment policy.';
    expect(reasonPrefixOf(message)).toBe('export_disabled');
    expect(withoutReasonPrefix(message)).toBe(
      'Plaintext export is disabled for api/prod by its environment policy.',
    );
    // A message that merely contains a colon is left alone.
    expect(withoutReasonPrefix('Note: nothing changed.')).toBe('Note: nothing changed.');
    expect(reasonPrefixOf('Note: nothing changed.')).toBeNull();
  });
});
