import * as z from 'zod/mini';
import { MAX_REDIRECT_PATH_LENGTH } from '@/lib/redirect-path';
import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, MAX_PENDING_TOKEN_LENGTH } from '../workos';

/**
 * The bodies the in-app sign-in routes accept (`server/in-app-sign-in.ts`).
 *
 * The same rules as every other schema here — `strictObject` with a fixed
 * unknown-field message, and messages about the *rule*, never the value. That
 * matters more here than anywhere: two of these fields are a password and a
 * one-time code, and `parseWith` already drops zod's `input` so neither can be
 * echoed back in a validation error.
 *
 * Deliberately loose about the address. Whether it reaches anybody is
 * WorkOS's question (and the inbox's); a strict pattern here would only refuse
 * the valid addresses it did not anticipate.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

const email = z
  .string()
  .check(
    z.minLength(1, 'Enter your email address.'),
    z.maxLength(MAX_EMAIL_LENGTH, 'That address is too long to be an address.'),
    z.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'That doesn’t look like an email address.'),
  );

/** A six-digit code. The client strips the spaces a pasted code arrives with. */
const code = z.string().check(z.regex(/^[0-9]{6}$/, 'Enter the six-digit code from the email.'));

/**
 * Where to land afterwards. Bounded here, and held to `safePostSignInPath`
 * where it is used — a value that fails that is replaced, not refused: whoever
 * followed a bad link still wanted to sign in.
 */
const next = z.optional(z.string().check(z.maxLength(MAX_REDIRECT_PATH_LENGTH)));

export const passwordSignInSchema = z.strictObject(
  {
    email,
    password: z
      .string()
      .check(
        z.minLength(1, 'Enter your password.'),
        z.maxLength(MAX_PASSWORD_LENGTH, 'That password is longer than any account has.'),
      ),
    next,
  },
  UNEXPECTED_FIELD,
);

export type PasswordSignInRequest = z.infer<typeof passwordSignInSchema>;

export const codeRequestSchema = z.strictObject({ email }, UNEXPECTED_FIELD);

export type CodeRequest = z.infer<typeof codeRequestSchema>;

export const codeSignInSchema = z.strictObject({ email, code, next }, UNEXPECTED_FIELD);

export type CodeSignInRequest = z.infer<typeof codeSignInSchema>;

export const emailVerificationSchema = z.strictObject(
  {
    /** WorkOS's pending-authentication token, as the password route handed it out. */
    pendingToken: z
      .string()
      .check(z.minLength(1), z.maxLength(MAX_PENDING_TOKEN_LENGTH), z.regex(/^[\x21-\x7e]+$/)),
    code,
    next,
  },
  UNEXPECTED_FIELD,
);

export type EmailVerificationRequest = z.infer<typeof emailVerificationSchema>;
