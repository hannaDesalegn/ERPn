-- 0007_company_standard_tax_rate
--
-- Where the authoritative tax rate lives. One column, because the decision it implements is one
-- sentence: section 2.9 as amended on 2026-09-11 puts the standard rate beside the other fiscal
-- settings a company configures.
--
-- WHY THIS WAS OPEN AT ALL. Section 3.3 requires the server to recompute every monetary figure,
-- tax rates included, from its own master data rather than trusting a form. No section said
-- which master data. Section 9.7 put "a tax engine beyond a single rate" in the future, which
-- says a single rate exists without saying where it is held.
--
-- WHY NOT ON THE PRODUCT. Reduced rates for food, books or medicine are real, and they are a
-- rate table keyed by category and jurisdiction rather than a column. Building the column now
-- would be that engine half made, and section 9.7 says it is future.
--
-- WHY NOT ON THE CUSTOMER. What varies per customer is exemption and reverse charge, not the
-- rate. Both are named as future in 9.7, and expressing them as a rate would encode the wrong
-- shape for the moment they arrive.
--
-- WHY IT MATTERS FOR POSTING. A customer invoice debits receivables for the gross, credits
-- revenue for the net and credits a tax liability for the difference. The rate and the account
-- that difference credits have to agree, or the entry does not balance. Section 2.9 already
-- holds the account mapping per company; this puts the rate at the same level, so the two cannot
-- drift apart into different scopes.
--
-- DEFAULT ZERO, DELIBERATELY. A company that has not configured tax charges none. The
-- alternative is to pick a jurisdiction's rate on its behalf, which is the kind of invention
-- that produces a wrong invoice nobody can explain. Zero is visible, wrong in an obvious way,
-- and corrected in configuration rather than in a release.

ALTER TABLE companies
    ADD COLUMN standard_tax_rate_percent numeric(9,6) NOT NULL DEFAULT 0;

-- Same precision as `sales_order_lines.tax_rate_percent`, which is what the line snapshots it
-- into. A rate the line could not represent exactly would round on the way onto the document.
ALTER TABLE companies
    ADD CONSTRAINT companies_standard_tax_rate_check
    CHECK (standard_tax_rate_percent >= 0 AND standard_tax_rate_percent <= 100);

COMMENT ON COLUMN companies.standard_tax_rate_percent IS
    'The company standard tax rate, per section 2.9 as amended 2026-09-11. Snapshotted onto each document line when the document is raised; changing it never alters a posted document.';
