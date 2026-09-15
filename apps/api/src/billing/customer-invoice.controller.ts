/**
 * The customer invoice HTTP surface.
 *
 * Deliberately thin, like the sales order controller beside it. Everything it does is translate: a
 * session into a scope, a header into an idempotency key, a path parameter into an identifier, and
 * a domain error into a status code. The decisions belong to the operation beneath it, which was
 * built and proved without any of this and stays callable without it.
 *
 * THREE ROUTES, AND THE ONE THAT IS ABSENT MATTERS MOST. Creating a draft, editing a draft, and
 * reading one. There is no post endpoint: section 12.2's posting transaction is the next
 * increment, and a route that answered "not implemented" would be a control that does nothing.
 * `invoices:post` already exists in the catalogue and nothing declares it yet.
 *
 * ONE TRANSACTION COVERS THE KEY, THE WRITE AND THE ANSWER, on both mutating routes. Section 11
 * requires the idempotency record to commit with the work it describes, so a retry after a failure
 * does the work rather than replaying a success that never happened.
 *
 * WHAT THE CALLER MAY SEND is which orders, which of their lines, how much of each, and two dates.
 * There is no price, no tax rate, no total, no status and no document number, because section 3.3
 * makes every one of those the server's to compute or the posting transaction's to allocate.
 * `strict` refuses one outright rather than ignoring it, per section 14.2.
 */

import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { HttpException } from '@nestjs/common';
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
import { principalOf } from '../http/principal.js';
import { withSerializationRetry } from '../http/serialization-retry.js';
import { fingerprintOf, IdempotencyConflictError, runIdempotently } from '../http/idempotency.js';
import { IdentityService, type CompanyContext } from '../identity/identity.service.js';
import { CustomerInvoiceDraftError } from './customer-invoice.service.js';
import {
  CustomerInvoiceService,
  type CustomerInvoiceView,
} from './customer-invoice.service.js';
import { IllegalCustomerInvoiceTransitionError } from './customer-invoice-status.js';

/** The header section 11 names. Required, as it is on every mutating sales route. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

const idempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'An idempotency key must be printable ASCII without spaces');

const identifier = z.string().uuid();

const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is a calendar day');

/**
 * What creating a draft accepts.
 *
 * IDENTIFIERS, QUANTITIES AND TWO DATES. `salesOrderIds` is a list because the domain model makes
 * it one: an invoice can cover several orders. `lines` is optional, and omitting it bills every
 * line of those orders that still has something left to invoice.
 *
 * Quantities are strings, not numbers. Section 4.3 keeps them exact, and a JSON number is a double
 * that has already lost the sixth decimal place by the time this sees it.
 */
const createBody = z
  .object({
    salesOrderIds: z.array(z.string().uuid()).min(1, 'An invoice needs at least one sales order').max(100),
    invoiceDate: calendarDay,
    dueDate: calendarDay.nullish(),
    lines: z
      .array(
        z
          .object({
            salesOrderLineId: z.string().uuid(),
            quantity: z.string().min(1).max(32).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500)
      .optional(),
  })
  .strict();

/**
 * What editing a draft accepts.
 *
 * The creation body plus the version the caller read, which section 10.1 requires. Still no price,
 * total, status or number: an edit may change no more than creation could set.
 */
const updateBody = createBody.extend({ version: z.number().int().min(1) });

/** The endpoint dimension of each key's identity, per section 11. Stable, not derived from a URL. */
const CREATE_ENDPOINT = 'POST customer-invoices';
const UPDATE_ENDPOINT = 'PUT customer-invoices/:id';

@Controller('customer-invoices')
export class CustomerInvoiceController {
  constructor(
    private readonly identity: IdentityService,
    private readonly invoices: CustomerInvoiceService,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * Creates a draft customer invoice from one or more confirmed sales orders.
   *
   * `invoices:create` rather than `invoices:post`. The catalogue separates raising a document from
   * committing it to the ledger, which is section 6.2's segregation of duties in the permission
   * vocabulary, and this endpoint does the first and cannot do the second.
   *
   * IT STAYS A DRAFT. No number is allocated, no journal entry written, no quantity consumed.
   */
  @RequirePermission('invoices:create')
  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() request: FastifyRequest): Promise<CustomerInvoiceView> {
    const parsed = createBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'That is not a customer invoice',
      );
    }

    const key = idempotencyKey.safeParse(request.headers[IDEMPOTENCY_HEADER]);
    if (!key.success) {
      throw new BadRequestException(
        'This operation requires an Idempotency-Key header, per section 11',
      );
    }

    const context = await this.contextFor(request);
    const principal = principalOf(request);
    const fingerprint = fingerprintOf(parsed.data);

    try {
      const outcome = await withSerializationRetry(() =>
        this.uow.inActorScope(
          actorScope({
            tenantId: context.tenantId,
            companyId: context.companyId,
            userId: principal.userId,
          }),
          (repositories) =>
            runIdempotently(
              repositories,
              { endpoint: CREATE_ENDPOINT, key: key.data, fingerprint },
              async () => {
                const draft = await this.invoices.createDraftIn(repositories, context.companyId, {
                  salesOrderIds: parsed.data.salesOrderIds,
                  invoiceDate: parsed.data.invoiceDate,
                  dueDate: parsed.data.dueDate ?? null,
                  ...(parsed.data.lines ? { lines: parsed.data.lines } : {}),
                });

                const view = await this.invoices.readIn(repositories, draft.invoice.id);
                if (!view) {
                  // Unreachable: it was written by this transaction moments ago.
                  throw new Error('The draft vanished inside its own transaction');
                }

                return { status: 201, body: view as unknown as Record<string, unknown> };
              },
            ),
        ),
      );

      return outcome.response.body as unknown as CustomerInvoiceView;
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Rewrites a draft customer invoice.
   *
   * THE 409 CARRIES THE INVOICE, NOT A SENTENCE, as the sales order edit does. Section 10.1 wants
   * the interface to be able to say what changed, and it cannot do that from a message alone, so
   * the conflict body is the invoice as it now stands, read after the failed transaction rolled
   * back.
   */
  @RequirePermission('invoices:create')
  @Put(':customerInvoiceId')
  @HttpCode(200)
  async update(
    @Param('customerInvoiceId') customerInvoiceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<CustomerInvoiceView> {
    if (!identifier.safeParse(customerInvoiceId).success) throw new NotFoundException('Not found');

    const parsed = updateBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'That is not a customer invoice',
      );
    }

    const key = idempotencyKey.safeParse(request.headers[IDEMPOTENCY_HEADER]);
    if (!key.success) {
      throw new BadRequestException(
        'This operation requires an Idempotency-Key header, per section 11',
      );
    }

    const context = await this.contextFor(request);
    const principal = principalOf(request);
    // The invoice is part of the intent, so two edits of different invoices under one key are two
    // different requests rather than a replay of the first.
    const fingerprint = fingerprintOf({ customerInvoiceId, ...parsed.data });

    try {
      const outcome = await withSerializationRetry(() =>
        this.uow.inActorScope(
          actorScope({
            tenantId: context.tenantId,
            companyId: context.companyId,
            userId: principal.userId,
          }),
          (repositories) =>
            runIdempotently(
              repositories,
              { endpoint: UPDATE_ENDPOINT, key: key.data, fingerprint },
              async () => {
                await this.invoices.updateDraftIn(repositories, context.companyId, {
                  customerInvoiceId,
                  expectedVersion: parsed.data.version,
                  salesOrderIds: parsed.data.salesOrderIds,
                  invoiceDate: parsed.data.invoiceDate,
                  dueDate: parsed.data.dueDate ?? null,
                  ...(parsed.data.lines ? { lines: parsed.data.lines } : {}),
                });

                const view = await this.invoices.readIn(repositories, customerInvoiceId);
                if (!view) throw new Error('The draft vanished inside its own transaction');

                return { status: 200, body: view as unknown as Record<string, unknown> };
              },
            ),
        ),
      );

      return outcome.response.body as unknown as CustomerInvoiceView;
    } catch (error) {
      if (error instanceof ConcurrencyConflictError) {
        throw await this.conflict(context, principal.userId, customerInvoiceId, error.message);
      }

      throw translate(error);
    }
  }

  /**
   * One customer invoice, as the detail screen shows it.
   *
   * NOT FOUND COVERS EVERYTHING IT SHOULD. An invoice in another company, in another tenant, and
   * one that does not exist all answer the same way, per section 6.1, so an identifier cannot be
   * used to learn what exists elsewhere.
   */
  @RequirePermission('invoices:view')
  @Get(':customerInvoiceId')
  async get(
    @Param('customerInvoiceId') customerInvoiceId: string,
    @Req() request: FastifyRequest,
  ): Promise<CustomerInvoiceView> {
    if (!identifier.safeParse(customerInvoiceId).success) throw new NotFoundException('Not found');

    const context = await this.contextFor(request);
    const principal = principalOf(request);

    const invoice = await this.invoices.getById(context, principal.userId, customerInvoiceId);
    if (!invoice) throw new NotFoundException('Not found');

    return invoice;
  }

  /**
   * The company context, from the session and never from the request.
   *
   * Section 7.3 wants the request id on an audit record, and this is where the request is. Nothing
   * in this package writes one; the posting transaction will, through the same context.
   */
  private async contextFor(request: FastifyRequest): Promise<CompanyContext> {
    const resolved = await this.identity.currentContext(principalOf(request));
    if (!resolved) throw new ForbiddenException('Forbidden');

    return { ...resolved, requestId: request.id };
  }

  /**
   * A 409 that says what the invoice is now.
   *
   * Read after the failed transaction rolled back, so it is the state that won rather than the
   * state that lost.
   */
  private async conflict(
    context: CompanyContext,
    actorUserId: string,
    customerInvoiceId: string,
    message: string,
  ): Promise<HttpException> {
    const current = await this.invoices.getById(context, actorUserId, customerInvoiceId);
    if (!current) return new NotFoundException('Not found');

    return new ConflictException({
      statusCode: 409,
      message,
      /** What the invoice is now, so the screen can show the difference rather than guess. */
      current,
    });
  }
}

function translate(error: unknown): unknown {
  if (error instanceof CustomerInvoiceDraftError) {
    if (error.reason === 'invoice_not_found') return new NotFoundException('Not found');
    // Unprocessable rather than not found for the rest. The request was well formed and the
    // endpoint exists; something it referenced is not usable. The message already says "not
    // found" without saying whether the record is missing or another company's, per section 6.1.
    return new UnprocessableEntityException(error.message);
  }

  if (error instanceof IllegalCustomerInvoiceTransitionError) {
    // Section 12.1 requires the refusal to name both states rather than failing generically.
    return new ConflictException(error.message);
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
