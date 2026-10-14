/**
 * A way for an async handler to notice that what it was started for is over.
 *
 * A dialog that is closed while it awaits a slow call — an Argon2 open, an
 * import, a recovery — cannot cancel the call, but it must not let the answer
 * land afterwards: reopened, it would show a decrypted archive or a
 * "Recovered" from a run the person walked away from. So each run takes a
 * ticket when it starts, closing the dialog ends every ticket issued so far,
 * and the run checks its ticket after each await before touching state.
 *
 * Held in a `useRef`, so it survives renders and is per component instance.
 */
export interface Generation {
  /** Starts a run; the returned function says whether that run is still current. */
  start: () => () => boolean;
  /** Ends every run started so far. */
  end: () => void;
}

export function createGeneration(): Generation {
  let current = 0;
  return {
    start: () => {
      const mine = current;
      return () => mine === current;
    },
    end: () => {
      current += 1;
    },
  };
}
