/**
 * Feature flags — env-var based, evaluated at build time.
 *
 * All flags use NEXT_PUBLIC_ prefix so they are available in both
 * Server Components and Client Components. Default is false (off)
 * when the env var is absent.
 */
export const featureFlags = {
  /**
   * Show the legacy /library photo upload path in the nav.
   * Set NEXT_PUBLIC_PHOTO_PATH_VISIBLE=true to re-enable.
   * Default: false — photo path is shelved pending Module 1 v2 ship.
   */
  photoPathVisible: process.env['NEXT_PUBLIC_PHOTO_PATH_VISIBLE'] === 'true',
}
