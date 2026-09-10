/**
 * The authentication endpoints.
 *
 * Thin on purpose. Every rule lives in `AuthenticationService`, which is testable without a web
 * server; this file translates between that service and HTTP, and does nothing a reviewer has to
 * reason about twice.
 *
 * TWO THINGS THIS FILE IS RESPONSIBLE FOR GETTING RIGHT.
 *
 * The response body carries no token and no session identifier, per criterion 3. The token
 * leaves in a cookie the browser will not hand to script, and a body carrying it would undo that
 * in one line, most likely added by someone making the frontend easier to write.
 *
 * Every rejection looks the same. A wrong password, an account that does not exist, a disabled
 * account and a locked out one all produce one status and one message. The service already
 * collapses the reasons; this keeps them collapsed. A distinct status for the lockout case was
 * considered and rejected: it would be more helpful to a person who mistyped their password four
 * times, and equally helpful to someone working out which of ten thousand addresses are real.
 */

import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { Public } from '../authorization/route-access.js';
import type { Env } from '../config/env.schema.js';
import {
  clearSessionCookie,
  readSessionToken,
  setSessionCookie,
  type CookiePolicy,
} from '../http/session-cookie.js';
import { AuthenticationService } from './authentication.service.js';

const loginBody = z.object({
  // Length bounded so a multi megabyte body cannot reach argon2. Section 14.3.
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

@Controller('auth')
export class AuthController {
  private readonly cookiePolicy: CookiePolicy;

  constructor(
    private readonly authentication: AuthenticationService,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.cookiePolicy = { secure: config.get('COOKIE_SECURE', { infer: true }) };
  }

  @Public()
  @Post('login')
  @HttpCode(204)
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const parsed = loginBody.safeParse(body);
    // A malformed body is answered like a failed login rather than with a validation error.
    // "Which field was wrong" is information, and there is nothing here worth telling an
    // unauthenticated caller.
    if (!parsed.success) throw signInFailed();

    const result = await this.authentication.login({
      email: parsed.data.email,
      password: parsed.data.password,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    if (result.outcome !== 'authenticated') throw signInFailed();

    setSessionCookie(reply, result.token, this.cookiePolicy);
    // 204, and nothing else. The client learns who it is by calling /me, which computes the
    // answer server side rather than believing a login response.
  }

  /**
   * Ends the session.
   *
   * Declared public, and idempotent. A client holding an expired or already revoked
   * cookie must still be able to clear it, and answering that with 401 would leave the browser
   * holding a dead credential with no way to be rid of it. It reveals nothing: the response is
   * identical whether the token was live, dead or never issued.
   *
   * That it accepts an unauthenticated request makes it a cross site forgery target in
   * principle. The cookie is SameSite=Strict, so a cross site request does not carry it and the
   * call revokes nothing. The token that section 6.5 requires is a later increment.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const token = readSessionToken(request);
    if (token) await this.authentication.logout(token);

    clearSessionCookie(reply, this.cookiePolicy);
  }
}

/** One rejection for every reason, built in one place so the wording cannot drift apart. */
function signInFailed(): UnauthorizedException {
  return new UnauthorizedException('Invalid email or password');
}
