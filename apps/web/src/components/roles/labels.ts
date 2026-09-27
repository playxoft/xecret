import type { Action } from '@xecret/core/authz';

/**
 * What each action lets a person do, in the words the Roles screen uses.
 *
 * `Record<Action, …>` for the reason `ROLE_CAPABILITIES` is one: an action
 * added to the product fails the build here until somebody has written down
 * what it means to the people deciding whether a role should have it. A list
 * would compile and silently leave the new action off the form — which, with
 * custom roles a positive list, would mean nobody could ever grant it.
 */
export const ACTION_LABELS: Readonly<Record<Action, string>> = {
  'project.read': 'See projects',
  'project.create': 'Create projects',
  'project.update': 'Rename projects and edit their details',
  'project.delete': 'Delete projects',
  'environment.read': 'See environments',
  'environment.create': 'Create environments',
  'environment.update': 'Change environment settings, including which is production',
  'environment.delete': 'Delete environments',
  'secret.read': 'Read secret values',
  'secret.create': 'Add secrets',
  'secret.update': 'Change secret values',
  'secret.delete': 'Delete secrets',
  'secret.rotate': 'Rotate secrets',
  'member.read': 'See who is in the organisation',
  'member.invite': 'Invite people',
  'member.update': 'Change members’ roles and access',
  'member.remove': 'Remove members',
  'audit.read': 'Read the audit log',
  'token.create': 'Create service tokens',
  'token.revoke': 'Revoke service tokens',
  'org.update': 'Rename the organisation',
  'org.delete': 'Delete the organisation',
};

/**
 * The actions in the groups the form shows them in, each group in the order
 * a person would reach for it. Every action appears exactly once — the test
 * beside this file holds that — so nothing is left off the form by being
 * forgotten here.
 */
export const ACTION_GROUPS: readonly { label: string; actions: readonly Action[] }[] = [
  {
    label: 'Secrets',
    actions: ['secret.read', 'secret.create', 'secret.update', 'secret.delete', 'secret.rotate'],
  },
  {
    label: 'Environments',
    actions: ['environment.read', 'environment.create', 'environment.update', 'environment.delete'],
  },
  {
    label: 'Projects',
    actions: ['project.read', 'project.create', 'project.update', 'project.delete'],
  },
  {
    label: 'Members',
    actions: ['member.read', 'member.invite', 'member.update', 'member.remove'],
  },
  { label: 'Service tokens', actions: ['token.create', 'token.revoke'] },
  { label: 'Organisation', actions: ['audit.read', 'org.update', 'org.delete'] },
];
