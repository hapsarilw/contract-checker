/**
 * Where the API is when a build names none (VITE_API_BASE_URL unset): the
 * local development server. One definition, because two places must agree
 * on it: api/client.js, which calls it, and scripts/staticHostHeaders.js,
 * whose Content-Security-Policy has to allow exactly that origin. Step 75's
 * CSP test found them disagreeing: a default build called localhost:3000
 * under a policy that allowed only 'self', and every request was refused.
 */
export const DEFAULT_API_BASE_URL = "http://localhost:3000";
