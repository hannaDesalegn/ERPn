/**
 * The sales order HTTP surface.
 *
 * One route, and it is deliberately thin. Everything it does is translate: a session into a
 * scope, a header into an idempotency key, a path parameter into an identifier, and a domain
 * error into a status code. The decisions all belong to `confirmSalesOrder`, which was built and
 * proved without any of this and stays callable without it.
 *
 * ONE TRANSACTION COVERS BOTH CONCERNS. The idempotency claim of section 11 and the confirming
 * transaction of section 12.2 run inside a single unit of work opened here. Claiming the key in a
 * transaction of its own would leave a record describing work that never committed, and every
 * retry after that would replay a success that did not happen. This is the one thing the endpoint
 * has to get right that the domain operation cannot get right on its own.
 *
 * WHAT THE CALLER MAY SEND. A path parameter and a header. There is no body, because there is
 * nothing about a confirmation for a caller to decide: the lines, their quantities, the products,
 * the warehouse, the number and the status all come from persisted records or from the server.
 * Section 14.3 warns about request bodies binding to entities, and the simplest defence against
 * mass assignment is a route with nothing to assign.
 */

import { Controller, Get, Param, Post, Query, Req, HttpCode } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { RequirePermission } from '../authorization/route-access.js';
import { actorScope, ConcurrencyConflictError, UnitOfWork } from '../database/index.js';
import { StockReservationError } from '../inventory/reservations.js';
import { principalOf } from '../http/principal.js';
import {
  fingerprintOf,
  IdempotencyConflictError,
  runIdempotently,
} from '../http/idempotency.js';
import { IdentityService } from '../identity/identity.service.js';
import { confirmSalesOrder, SalesOrderConfirmationError } from './confirm-sales-order.js';
import {
  SalesOrderService,
  type SalesOrderPageView,
  type SalesOrderView,
} from './sales-order.service.js';
import { IllegalSalesOrderTransitionError } from './sales-order-status.js';

/**
 * The header section 11 names.
 *
 * Required rather than optional. The clause says every state changing endpoint accepts one, and
 * confirming is the operation whose accidental repetition the section exists to prevent: a
 * timeout during confirmation, retried, must not reserve the stock twice.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Printable ASCII, bounded, matching what the column will take. */
const idempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'An idempotency key must be printable ASCII without spaces');

const identifier = z.string().uuid();

/**
 * What the list accepts, and the shape of every refusal it does not make.
 *
 * Strict, so an unknown field is rejected rather than ignored, per section 14.2. There is
 * deliberately no tenant or company here: both come from the session, and accepting either would
 * be offering a caller a way to ask about somebody else's orders.
 *
 * The sort key is a union rather than a string. A column name taken from a query string is the
 * usual way a list endpoint becomes an injection, and the repository is written so that it cannot
 * receive one.
 *
 * The page size is bounded here rather than in the service, because this is where the untrusted
 * number arrives. A caller asking for a million rows gets a hundred.
 */
const listQuery = z
  .object({
    search: z.string().max(200).optional(),
    status: z.union([z.string(), z.array(z.string())]).optional(),
    warehouseId: z.union([z.string(), z.array(z.string())]).optional(),
    sortBy: z.enum(['docNumber', 'orderDate', 'customer', 'total', 'status']).default('orderDate'),
    sortDir: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

/** A repeated query parameter arrives as an array and a single one as a string. */
const many = (value: string | string[] | undefined): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

/** The endpoint dimension of the key's identity, per section 11. Stable, not derived from a URL. */
const ENDPOINT = 'POST sales-orders/:id/confirm';

export interface ConfirmationView {
  id: string;
  status: string;
  docNumber: string;
  reservations: number;
}

@Controller('sales-orders')
export class SalesOrderController {
  constructor(
    private readonly identity: IdentityService,
    private readonly sales: SalesOrderService,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * This company's sales orders, one page at a time.
   *
   * The company comes from the session and appears nowhere in the query, so there is no parameter
   * through which a caller could ask about another one. `sales:view`, the same capability the
   * detail read needs, because a list and the documents in it are the same thing to look at.
   */
  @RequirePermission('sales:view')
  @Get()
  async list(
    @Query() rawQuery: unknown,
    @Req() request: FastifyRequest,
  ): Promise<SalesOrderPageView> {
    const parsed = listQuery.safeParse(rawQuery ?? {});
    if (!parsed.success) {
      throw new BadRequestException('That is not a query this list understands');
    }

    const principal = principalOf(request);
    const context = await this.identity.currentContext(principal);
    if (!context) throw new ForbiddenException('Forbidden');

    const { search, status, warehouseId, ...rest } = parsed.data;

    return this.sales.list(context, principal.userId, {
      ...rest,
      ...(search ? { search } : {}),
      ...(many(status) ? { statuses: many(status) } : {}),
      ...(many(warehouseId) ? { warehouseIds: many(warehouseId) } : {}),
    });
  }

  /**
   * One sales order, as the detail screen shows it.
   *
   * `sales:view` rather than `sales:confirm`: reading an order is what every role in the sales
   * path does, and gating a read behind the capability to act on it would be the wrong shape.
   *
   * NOT FOUND COVERS EVERYTHING IT SHOULD. An order in another company, in another tenant, and
   * one that does not exist all answer the same way, per section 6.1, so an identifier cannot be
   * used to learn what exists elsewhere. The service already answers null for all three; this
   * only turns that into a status code.
   */
  @RequirePermission('sales:view')
  @Get(':salesOrderId')
  async get(
    @Param('salesOrderId') salesOrderId: string,
    @Req() request: FastifyRequest,
  ): Promise<SalesOrderView> {
    if (!identifier.safeParse(salesOrderId).success) throw new NotFoundException('Not found');

    const principal = principalOf(request);
    const context = await this.identity.currentContext(principal);
    if (!context) throw new ForbiddenException('Forbidden');

    const order = await this.sales.getById(context, principal.userId, salesOrderId);
    if (!order) throw new NotFoundException('Not found');

    return order;
  }

  /**
   * Confirms a sales order.
   *
   * The guard has already established a session and the `sales:confirm` capability in the acting
   * company before this runs, per section 6.2's deny by default. What is left here is the company
   * context, which comes from the session rather than the request, and the translation below.
   */
  @RequirePermission('sales:confirm')
  @Post(':salesOrderId/confirm')
  @HttpCode(200)
  async confirm(
    @Param('salesOrderId') salesOrderId: string,
    @Req() request: FastifyRequest,
  ): Promise<ConfirmationView> {
    if (!identifier.safeParse(salesOrderId).success) {
      // Not a bad request. An identifier that cannot name an order is indistinguishable from one
      // naming another company's, per section 6.1, and answering differently would let a caller
      // tell a malformed identifier from a real one they may not see.
      throw new NotFoundException('Not found');
    }

    const key = idempotencyKey.safeParse(request.headers[IDEMPOTENCY_HEADER]);
    if (!key.success) {
      throw new BadRequestException(
        'This operation requires an Idempotency-Key header, per section 11',
      );
    }

    const principal = principalOf(request);
    const context = await this.identity.currentContext(principal);
    if (!context) throw new ForbiddenException('Forbidden');

    // The request's identity, for the replay comparison. The path parameter is the whole of what
    // the caller chose, so it is the whole of the fingerprint.
    const fingerprint = fingerprintOf({ salesOrderId });

    try {
      const outcome = await this.uow.inActorScope(
        actorScope({
          tenantId: context.tenantId,
          companyId: context.companyId,
          userId: principal.userId,
        }),
        (repositories) =>
          runIdempotently(
            repositories,
            { endpoint: ENDPOINT, key: key.data, fingerprint },
            async () => {
              const { order, reservationIds } = await confirmSalesOrder(repositories, context, {
                salesOrderId,
              });

              return {
                status: 200,
                body: {
                  id: order.id,
                  status: order.status,
                  // Never null on a confirmed order: the schema refuses that combination.
                  docNumber: order.docNumber ?? '',
                  reservations: reservationIds.length,
                } satisfies ConfirmationView,
              };
            },
          ),
      );

      return outcome.response.body as unknown as ConfirmationView;
    } catch (error) {
      throw translate(error);
    }
  }
}

/**
 * Domain errors into the vocabulary the rest of the API already speaks.
 *
 * Nothing here invents a status code, and nothing lets a driver error through: an unrecognised
 * failure is rethrown so the framework answers 500 rather than this guessing at a meaning.
 */
function translate(error: unknown): unknown {
  if (error instanceof SalesOrderConfirmationError) {
    // `not_found` already covers another company's order and a missing one alike, per 6.1.
    if (error.reason === 'not_found') return new NotFoundException('Not found');
    if (error.reason === 'forbidden') return new ForbiddenException('Forbidden');
    // A real order in a state that cannot be confirmed. The caller may see why.
    return new UnprocessableEntityException(error.message);
  }

  if (error instanceof IllegalSalesOrderTransitionError) {
    // Section 12.1 requires the refusal to name both states rather than failing generically, and
    // an already confirmed order is the ordinary case here.
    return new ConflictException(error.message);
  }

  if (error instanceof StockReservationError) {
    // Section 8.5's oversell, refused inside the transaction. Unprocessable rather than conflict:
    // the request was well formed and the state is not in dispute, there is simply not enough.
    return new UnprocessableEntityException(error.message);
  }

  if (error instanceof ConcurrencyConflictError) {
    // Section 10.1's lost update, surfaced as the conflict it is so a client can re-read.
    return new ConflictException(error.message);
  }

  if (error instanceof IdempotencyConflictError) {
    // Section 11: the same key with a different request is a conflict, never a silent replay.
    return new ConflictException(error.message);
  }

  return error;
}
