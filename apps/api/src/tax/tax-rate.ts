/**
 * The single place a tax rate is resolved.
 *
 * Contract section 2.9, as amended on 2026-09-11: the authoritative rate is a standard rate held
 * per company, and resolving one is one function that every document line goes through. That
 * last part is the whole reason this file exists on its own for three lines of code.
 *
 * WHAT IT BUYS. Section 9.7 puts a real tax engine in the future: jurisdictions, exemptions, and
 * reverse charge for cross border trade. When that arrives it replaces the body of this function
 * and nothing else. Every line already stores the rate that applied when it was raised, per
 * section 3.4, so no past document moves and no call site changes.
 *
 * WHAT IT DOES NOT DO. It does not read the database, does not know about a customer, and does
 * not know about a product. Today none of those participates in the answer, and taking them as
 * parameters now would be the future engine's signature with none of its behaviour, which reads
 * in review as though the work were done.
 */

/** The part of a company this resolution actually depends on. */
export interface TaxableCompany {
  standardTaxRatePercent: string;
}

/**
 * The rate to apply to a document line, as a decimal string at the schema's scale.
 *
 * A string rather than a number, for the reason section 4.3 gives: the value goes onto a line as
 * `NUMERIC(9,6)` and a double would round the sixth place away in passing.
 */
export function resolveTaxRate(company: TaxableCompany): string {
  return company.standardTaxRatePercent;
}
