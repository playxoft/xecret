'use client';

import {
  Alert,
  Button,
  CopyButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui';

/** A signing secret on its one trip to the screen, and why it is making it. */
export interface RevealedSigningSecret {
  /** The endpoint's host, to say which receiver this belongs to. Never the URL. */
  host: string;
  secret: string;
  reason: 'created' | 'rotated';
}

/**
 * The `whsec_…` signing secret, shown exactly once.
 *
 * ── Why once ──
 * The server seals the secret under the organisation's key before the row is
 * written and no route ever opens it again — not for this dashboard, not for an
 * administrator, not for support. Create and rotate are the two responses that
 * carry it, and this dialog is the only place either is rendered.
 *
 * ── Where the plaintext lives while it is here ──
 * In the caller's state, and nowhere else: not in a URL, not in storage, not in
 * a toast. Closing this dialog is the caller setting it to `null`, which is the
 * last reference this page holds. The dialog cannot be dismissed by a stray
 * click on the backdrop for the same reason the token dialog cannot: the click
 * that closes it is the click that loses the secret, and it should be a
 * deliberate one.
 *
 * `CopyButton` is used despite its warning about secret values, and the warning
 * does not apply: that note is about values *stored in an environment*, which
 * must be read through the audited reveal. This is a credential being handed to
 * its owner on creation, the same as a service token is.
 */
export function SigningSecretDialog({
  revealed,
  onClose,
}: {
  revealed: RevealedSigningSecret | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={revealed !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent onPointerDownOutside={(event) => event.preventDefault()}>
        {revealed !== null ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy the signing secret now</DialogTitle>
              <DialogDescription>
                {revealed.reason === 'created'
                  ? `Every delivery to ${revealed.host} is signed with this secret. Give it to the receiver so it can verify that a delivery came from xecret.`
                  : `This replaces the secret for ${revealed.host}. The old one stopped signing the moment this was made, so the receiver rejects every delivery from now on until it has this one.`}
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="flex flex-col gap-3">
              <div className="border-line bg-canvas-inset flex items-center gap-2 rounded-lg border px-3 py-2">
                <code className="text-fg min-w-0 flex-1 font-mono text-sm break-all select-all">
                  {revealed.secret}
                </code>
                <CopyButton
                  value={revealed.secret}
                  label={`the signing secret for ${revealed.host}`}
                />
              </div>

              <Alert tone="warning" title="You will not see this again">
                <p>
                  xecret keeps the secret sealed and no screen or request can show it again. If it
                  is lost, rotate it from the endpoint’s menu and give the receiver the new one.
                </p>
              </Alert>

              <p className="text-fg-subtle text-sm leading-5">
                Deliveries follow Standard Webhooks: verify the{' '}
                <code className="font-mono">webhook-signature</code> header over the raw body with
                this secret, and treat a repeated <code className="font-mono">webhook-id</code> as a
                retry of a delivery you already have.
              </p>
            </DialogBody>

            <DialogFooter>
              <Button variant="primary" onClick={onClose}>
                I have copied it
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
