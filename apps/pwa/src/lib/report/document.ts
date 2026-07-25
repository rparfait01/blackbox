/**
 * The certified report document (Brief 29 §1, §2, §4).
 *
 * The implementation lives in @blackbox/shared because the document format is a contract
 * between the device that renders a report, the Worker that signs it, and the verifier
 * that checks it — two copies would drift and every document would fail to verify. This
 * module exists only so the report code reads against a local path; it adds no behaviour.
 *
 * See packages/shared/src/report-document.ts, and docs/brief29/VERIFICATION.md for the
 * third-party specification.
 */
export {
  computeEvidenceHashes,
  DOCUMENT_FORMAT,
  parseReportDocument,
  renderEvidenceText,
  renderReportHtml,
  VERIFICATION_URL,
  type ParsedReport,
  type ReportDocumentInput,
} from '@blackbox/shared';
export type { CertifiedReportPayload, ReportAttestation as Attestation } from '@blackbox/shared';
