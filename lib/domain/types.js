/**
 * Core domain types for dsh-usage-center.
 *
 * Design rules:
 * - The usage record is a fact derived from the durable session log; it is
 *   never rewritten when prices change.
 * - Missing values are `null`, never `0`. "Unknown" and "zero" are different
 *   facts and must stay distinguishable at every layer.
 */
export {};
