/**
 * The release this client was built from.
 *
 * Compiled in rather than fetched, so it names the bundle actually running
 * in the page. That matters twice: the app is a service-worker-backed PWA
 * and a desktop shell that loads the live site, so the page in front of you
 * is not always the one the server just deployed; and every log captured
 * from a browser should say which build produced it.
 */
export const APP_VERSION: string = __APP_VERSION__;
