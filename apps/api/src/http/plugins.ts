/**
 * Fastify plugins the application needs, registered in one place.
 *
 * Both the process entry point and the HTTP tests go through this function. When they diverge,
 * the tests exercise a server that is not the one deployed, and the failure shows up as a
 * feature that works in tests and not in production, or the reverse.
 */

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';

export async function registerHttpPlugins(app: NestFastifyApplication): Promise<void> {
  // Parsing only. No `secret`, so no signed cookies: the session value is 256 bits from a
  // cryptographic generator and is looked up by hash, which is what makes it unguessable. A
  // signature would add a second secret to manage and prove nothing the lookup does not.
  await app.register(fastifyCookie);
}
