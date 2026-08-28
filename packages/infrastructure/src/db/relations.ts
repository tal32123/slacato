/**
 * Relations deliberately stay private to Drizzle adapters. The first persistence
 * slice uses explicit transactional queries; later read adapters can add Drizzle
 * relation declarations without leaking ORM types across the core boundary.
 */
export {};
