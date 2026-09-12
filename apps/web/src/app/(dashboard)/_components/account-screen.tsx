'use client';

import { useState } from 'react';

import { api, errorMessage } from '@/lib/api';
import { THEME_LABELS } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import { useTheme } from '@/components/layout';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  useToast,
} from '@/components/ui';
import { apiPath } from '../_lib/paths';
import { useSession } from './session';

/**
 * The General tab of settings: who this account is, and how xecret looks.
 *
 * Security controls — password, vault, devices — live in `security-screen.tsx`,
 * and the irreversible actions in `danger-screen.tsx`. The split mirrors how
 * people arrive: routine personalisation should not share a screen with the
 * controls that end sessions or accounts.
 */

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; Icon: typeof SunIcon }> = [
  { value: 'light', Icon: SunIcon },
  { value: 'dark', Icon: MoonIcon },
  { value: 'system', Icon: MonitorIcon },
];

/** The cap the endpoint enforces, mirrored so the field can count down to it. */
const NAME_MAX_LENGTH = 120;

export function AccountScreen() {
  const { user } = useSession();
  const { preference, setPreference } = useTheme();

  return (
    <div className="flex flex-col gap-6">
      {/* `id` plus `data-settings-section`: the settings layout's contents
          list is built from these, and the id makes each card a link somebody
          can send. See `settings-toc.tsx`. */}
      <Card id="profile" data-settings-section>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Your name is yours to change and is what teammates see next to your work. Your email
            address comes from your sign-in provider and is what the audit log identifies you by, so
            it is not editable here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <NameForm />
          <Field label="Email">
            <Input value={user.email} readOnly disabled />
          </Field>
          {user.emailVerified ? null : (
            <Alert tone="warning" title="This address is not verified">
              Sign out and follow the link in the verification email. An unverified address cannot
              start a new session.
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card id="appearance" data-settings-section>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Stored in this browser only, so it never travels with your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* A radio group rather than a toggle: "System" is a third state, and
              it is the one most people want back once they have left it. */}
          <fieldset>
            <legend className="sr-only">Theme</legend>
            <div className="flex flex-wrap gap-2">
              {THEME_OPTIONS.map(({ value, Icon }) => (
                <label
                  key={value}
                  className={
                    preference === value
                      ? 'border-accent bg-accent-tint text-accent-text flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium'
                      : 'border-line text-fg-muted hover:bg-surface-hover flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition-colors'
                  }
                >
                  <input
                    type="radio"
                    name="theme"
                    value={value}
                    checked={preference === value}
                    onChange={() => setPreference(value)}
                    className="sr-only"
                  />
                  <Icon aria-hidden="true" className="size-4" />
                  {THEME_LABELS[value]}
                </label>
              ))}
            </div>
          </fieldset>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The one editable thing about an account.
 *
 * ── Why an empty field is a valid save ──
 * Because the alternative is a name somebody cannot get rid of. Clearing it
 * sends `null`, and the account goes back to being identified by its email
 * address — which is what it was identified by all along in the audit log, and
 * what the member lists fall back to. So the field is not required, and the
 * button is disabled only while nothing has changed.
 *
 * The session is re-read rather than patched locally: the display name is on
 * screen in the user menu and in member lists this component does not own, and
 * `refresh` is the seam that exists for exactly this.
 */
function NameForm() {
  const { user, refresh } = useSession();
  const { toast } = useToast();

  const [name, setName] = useState(user.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const trimmed = name.trim();
  const tooLong = trimmed.length > NAME_MAX_LENGTH;
  const unchanged = trimmed === (user.displayName ?? '');

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || unchanged || tooLong) return;

    setSaving(true);
    setProblem(null);
    try {
      await api.patch(apiPath.account(), { displayName: trimmed.length === 0 ? null : trimmed });
      toast({ variant: 'success', title: 'Name updated' });
      // Not awaited for the toast's sake, but awaited before the button comes
      // back: `unchanged` is computed from the session, so returning the form to
      // its resting state is the refresh landing.
      await refresh();
    } catch (cause) {
      setProblem(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-3">
      <Field
        label="Name"
        hint="Shown to teammates in member lists. Leave it empty to be identified by your email address."
        // The length is reported rather than enforced with `maxLength`: a name
        // seeded from a provider can arrive over the limit, and silently
        // swallowing the end of it as somebody edits is worse than saying so.
        error={
          problem ??
          (tooLong
            ? `That name is ${trimmed.length} characters; the limit is ${NAME_MAX_LENGTH}.`
            : null)
        }
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Not set"
          autoComplete="name"
        />
      </Field>

      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={saving} disabled={unchanged || tooLong}>
          Save name
        </Button>
      </div>
    </form>
  );
}
