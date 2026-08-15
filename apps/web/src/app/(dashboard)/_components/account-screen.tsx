'use client';

import { THEME_LABELS } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import { useTheme } from '@/components/layout';
import {
  Alert,
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
} from '@/components/ui';
import { useSession } from './session';

/**
 * The General tab of settings: who this account is, and how xecret looks.
 *
 * Security controls — password, PIN, devices — live in `security-screen.tsx`,
 * and the irreversible actions in `danger-screen.tsx`. The split mirrors how
 * people arrive: routine personalisation should not share a screen with the
 * controls that end sessions or accounts.
 */

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; Icon: typeof SunIcon }> = [
  { value: 'light', Icon: SunIcon },
  { value: 'dark', Icon: MoonIcon },
  { value: 'system', Icon: MonitorIcon },
];

export function AccountScreen() {
  const { user } = useSession();
  const { preference, setPreference } = useTheme();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Your identity comes from your sign-in provider. xecret stores a copy so it can show who
            did what, and does not let you edit it here — changing it in one place and not the other
            would make the audit log disagree with your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field label="Name">
            <Input value={user.displayName ?? ''} readOnly disabled placeholder="Not set" />
          </Field>
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

      <Card>
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
