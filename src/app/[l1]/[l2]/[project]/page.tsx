// ADR-0020 folder/project parity (Franck 2026-05-26 21:14):
// the project dashboard is the SAME Dashboard component used at
// root and folder scopes. Scope is derived from the URL by the
// shared getCurrentScope() helper, so this file is a pure re-export.
export { default } from '@/app/page';
