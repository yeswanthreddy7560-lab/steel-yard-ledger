# Customer Register Test Report

Date: 2026-11-24T07:23:13.376Z

- [x] Expiry unit checks: one calendar month with month-end clamping
- [x] Adding a customer returns the record with a one-month expiry
- [x] Duplicate bill numbers are rejected for the same owner
- [x] The same bill number is allowed for a different owner
- [x] Input validation rejects invalid payloads
- [x] Adding a future-dated record computes status correctly
- [x] A past-dated record is immediately expired and deletable
- [x] Deleting an unexpired record is refused
- [x] Editing fields keeps the expiry date derived from the record's date
- [x] Editing the date recalculates the expiry date
- [x] Search finds records by name, phone, bill, village and book no
- [x] Status and date-range filters work
- [x] Dashboard summary counts match the owner's register
- [x] Serial numbering is derived from display order, not database ids
- [x] Pagination with 1,000 records stays fast and correct — created 1000 records in 1526ms; paged+searched in 58ms
- [x] Anonymous access is rejected with 401
- [x] Requests without a CSRF token are rejected
- [x] Owner B cannot see, edit or delete owner A's records (IDOR)
- [x] Owner B's register is unaffected by owner A's data
- [x] CSV export matches the register and includes recordA1
- [x] SQL injection payloads are stored inert or rejected
- [x] Script payloads are returned verbatim (frontend renders as text)
- [x] Page route is protected: /customers redirects anonymous users to /login
- [x] Invalid ids are rejected with 400
