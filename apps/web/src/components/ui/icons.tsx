import type { SVGProps } from 'react';

/**
 * The application's icon set.
 *
 * Hand-drawn on a 24×24 grid rather than pulled from an icon library: this is
 * every icon the product needs, it costs no dependency, and a shared stroke
 * weight and terminal style is what makes an interface look drawn rather than
 * assembled.
 *
 * Icons are decorative by default (`aria-hidden`), because they sit beside a
 * text label almost everywhere. Where an icon *is* the only content — an
 * icon-only button — the accessible name belongs on the control, not here.
 */

export type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);

export const ChevronUpDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const MinusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const ArrowRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
  </Icon>
);

export const EyeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const EyeOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7c-.9.9-1.5 1.8-1.5 1.8S6 15.5 12 15.5c1.2 0 2.3-.2 3.2-.6" />
    <path d="M18.8 13.2c1.5-1.4 2.2-2.7 2.2-2.7S17.5 4 11.5 4c-.9 0-1.7.1-2.4.4" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3 3 18 18" />
  </Icon>
);

/** An arrow cursor — "this happens where the pointer is". */
export const PointerIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 3.5 18.5 9.9l-6.2 1.8-1.9 6.3L5 3.5Z" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </Icon>
);

export const MenuIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h16" />
  </Icon>
);

export const PanelLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9.5 4v16" />
  </Icon>
);

export const UserIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Icon>
);

export const UsersIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="10" cy="8" r="3.5" />
    <path d="M3 20a7 7 0 0 1 14 0" />
    <path d="M16.5 4.7a3.5 3.5 0 0 1 0 6.6" />
    <path d="M18 14.3A7 7 0 0 1 21.5 20" />
  </Icon>
);

export const LogOutIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 16 4-4-4-4" />
    <path d="M20 12H10" />
  </Icon>
);

export const SunIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.9 4.9 1.5 1.5" />
    <path d="m17.6 17.6 1.5 1.5" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m4.9 19.1 1.5-1.5" />
    <path d="m17.6 6.4 1.5-1.5" />
  </Icon>
);

export const MoonIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const MonitorIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
    <path d="M9 20h6" />
    <path d="M12 16.5V20" />
  </Icon>
);

export const AlertTriangleIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4" />
    <path d="M12 17h.01" />
  </Icon>
);

export const AlertCircleIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5" />
    <path d="M12 16.5h.01" />
  </Icon>
);

export const InfoIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <path d="M12 7.5h.01" />
  </Icon>
);

export const CheckCircleIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
  </Icon>
);

export const ExternalLinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 4h6v6" />
    <path d="m20 4-8.5 8.5" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Icon>
);

export const TerminalIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.5" y="4" width="19" height="16" rx="2" />
    <path d="m7 10 2.5 2.5L7 15" />
    <path d="M13 15h4" />
  </Icon>
);

export const KeyIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="15.5" r="4" />
    <path d="m11 12.5 8.5-8.5" />
    <path d="m16 7.5 2.5 2.5" />
  </Icon>
);

export const PencilIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    <path d="m14.5 6.5 3 3" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
    <path d="M10.5 11v6" />
    <path d="M13.5 11v6" />
  </Icon>
);

export const HistoryIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3.5 4.5V9H8" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
);

export const ShieldIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3 4.5 6v5.5c0 4.5 3.1 7.9 7.5 9.5 4.4-1.6 7.5-5 7.5-9.5V6L12 3Z" />
  </Icon>
);

export const LockIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const LockOpenIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 7.4-2.1" />
  </Icon>
);

/** The overflow affordance: more of a set than fits, not "settings". */
export const MoreHorizontalIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Icon>
);

export const ShieldCheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3 4.5 6v5.5c0 4.5 3.1 7.9 7.5 9.5 4.4-1.6 7.5-5 7.5-9.5V6L12 3Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

export const BoxIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20.5 8.2v7.6a1.5 1.5 0 0 1-.8 1.3l-6.9 3.8a1.5 1.5 0 0 1-1.6 0l-6.9-3.8a1.5 1.5 0 0 1-.8-1.3V8.2a1.5 1.5 0 0 1 .8-1.3l6.9-3.8a1.5 1.5 0 0 1 1.6 0l6.9 3.8a1.5 1.5 0 0 1 .8 1.3Z" />
    <path d="m3.8 7.4 8.2 4.5 8.2-4.5" />
    <path d="M12 21v-9.1" />
  </Icon>
);

export const LayersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z" />
    <path d="m3 12.5 9 4.5 9-4.5" />
    <path d="m3 17 9 4.5 9-4.5" />
  </Icon>
);

export const FileTextIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6" />
    <path d="M9 17h4" />
  </Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 4v8" />
    <path d="M5 16v4" />
    <path d="M12 4v3" />
    <path d="M12 11v9" />
    <path d="M19 4v11" />
    <path d="M19 19v1" />
    <path d="M2.5 12h5" />
    <path d="M9.5 7h5" />
    <path d="M16.5 15h5" />
  </Icon>
);

export const BookIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2V5Z" />
    <path d="M4 18a2 2 0 0 0 2 2h13" />
  </Icon>
);

export const RefreshIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" />
    <path d="M4 4v4.5h4.5" />
    <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5" />
    <path d="M20 20v-4.5h-4.5" />
  </Icon>
);

export const MailIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="m3.5 7 7.4 5.3a2 2 0 0 0 2.2 0L20.5 7" />
  </Icon>
);

export const GitHubIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M15 21.5v-3.3c0-1 -.3-1.7-.9-2.3 2.9-.3 5.9-1.4 5.9-6.2a4.8 4.8 0 0 0-1.3-3.3 4.5 4.5 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.6 2.8 5.6 3.1 5.6 3.1a4.5 4.5 0 0 0-.1 3.3A4.8 4.8 0 0 0 4.2 9.7c0 4.8 2.9 5.9 5.8 6.2-.4.4-.7 1-.8 1.7v4" />
    <path d="M9.2 17.6c-2.9 1-3.4-1.4-4.7-1.7" />
  </Icon>
);

/**
 * Google's mark, in Google's colours.
 *
 * Google's brand guidelines require the four-colour logo on their sign-in
 * button and forbid recolouring it, so this one is filled rather than stroked
 * and does not inherit `currentColor`.
 */
export const GoogleIcon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false" {...props}>
    <path
      fill="#4285F4"
      d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.44a5.5 5.5 0 0 1-2.39 3.6v3h3.86c2.26-2.08 3.56-5.15 3.56-8.79Z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.87-3a7.2 7.2 0 0 1-10.72-3.78H1.35v3.09A11.99 11.99 0 0 0 12 24Z"
    />
    <path
      fill="#FBBC05"
      d="M5.35 14.3a7.14 7.14 0 0 1 0-4.59V6.62H1.35a12 12 0 0 0 0 10.77l4-3.09Z"
    />
    <path
      fill="#EA4335"
      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.3 0 3.25 2.7 1.35 6.62l4 3.09A7.16 7.16 0 0 1 12 4.75Z"
    />
  </svg>
);
