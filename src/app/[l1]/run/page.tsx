// ADR-0020 folder/project parity: re-export of the legacy page.
// Scope is resolved from the URL by getCurrentScope() inside the
// page itself, so the same component renders here scoped to the
// folder's descendants.
export { default, metadata } from '@/app/run/page';
