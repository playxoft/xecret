import { describe, expect, it } from 'vitest';
import { ApiError, errorMessage } from './api';

/**
 * What a caller with no form to attach field errors to gets to show.
 *
 * `errors.validation` sends a fixed, contentless sentence and puts the detail in
 * `fields`, because a form wants each problem beside the input that caused it.
 * Screens without such a form — the CLI consent card, a confirmation dialog —
 * used to render the sentence alone, which says a request failed and nothing
 * about which part or what to do.
 */
describe('errorMessage', () => {
  it('says what actually failed, rather than that something did', () => {
    const error = new ApiError({
      code: 'validation_failed',
      message: 'The request could not be processed.',
      status: 422,
      requestId: null,
      fields: [{ field: 'orgSlug', message: 'That slug is reserved. Choose a different one.' }],
    });

    expect(errorMessage(error)).toBe('That slug is reserved. Choose a different one.');
  });

  it('deduplicates one problem repeated across fields', () => {
    const problem = { message: 'A slug cannot be empty.' };
    const error = new ApiError({
      code: 'validation_failed',
      message: 'The request could not be processed.',
      status: 422,
      requestId: null,
      fields: [
        { field: 'items.0.slug', ...problem },
        { field: 'items.1.slug', ...problem },
      ],
    });

    expect(errorMessage(error)).toBe('A slug cannot be empty.');
  });

  it('falls back to the top-level message when there is no field detail', () => {
    const error = new ApiError({
      code: 'validation_failed',
      message: 'The request could not be processed.',
      status: 422,
      requestId: null,
    });

    expect(errorMessage(error)).toBe('The request could not be processed.');
  });

  // Every other code already carries a written message; only `validation_failed`
  // deliberately does not.
  it('leaves every other code alone', () => {
    const error = new ApiError({
      code: 'forbidden',
      message: 'You do not have permission to perform this action.',
      status: 403,
      requestId: null,
      fields: [{ field: 'ignored', message: 'not this' }],
    });

    expect(errorMessage(error)).toBe('You do not have permission to perform this action.');
  });

  /**
   * A thrown value that is not an `ApiError` is collapsed to a fixed string: an
   * arbitrary exception's message may have been built from the request payload,
   * which in this product may be a secret value.
   */
  it('never reads the message of an arbitrary throw', () => {
    expect(errorMessage(new Error('DB_PASSWORD=hunter2 is invalid'))).toBe(
      'Something went wrong. Please try again.',
    );
  });
});
