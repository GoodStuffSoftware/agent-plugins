/**
 * appquit.mjs - ask the Claude desktop app to quit (go-live `--quit-app`).
 *
 * Seam only for now: the quit is not implemented, so this reports `{supported:false}` and go-live
 * tells the user to quit from the tray icon or the app menu. The runner waits either way.
 */

/** @returns {Promise<{supported:boolean, requested?:boolean, reason?:string}>} */
export async function requestAppQuit() {
  return { supported: false, reason: 'quitting the app from here is not available yet' };
}
