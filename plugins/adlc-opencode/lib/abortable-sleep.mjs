// abortable-sleep.mjs — the event loop's reconnect backoff.

/** Resolves after `ms`, or as soon as `signal` aborts; leaves no listener behind. */
export const abortableSleep = (ms, signal) => new Promise((done) => {
  if (signal.aborted) return done();
  const onAbort = () => { clearTimeout(timer); done(); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); done(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});
