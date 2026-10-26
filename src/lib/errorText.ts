import { t } from '../i18n/t';

export interface FriendlyError {
  title: string;
  message: string;
}

/**
 * Returns a friendly, localized title for an error code (instead of technical codes like "IO", "DB", "VALIDATION").
 */
export function getFriendlyErrorTitle(code: string): string {
  const upper = (code || '').toUpperCase();
  switch (upper) {
    case 'VALIDATION':
      return t('errors.code_validation');
    case 'CONFLICT':
      return t('errors.code_conflict');
    case 'NOT_FOUND':
      return t('errors.code_not_found');
    case 'IO':
      return t('errors.code_io');
    case 'DB':
      return t('errors.code_db');
    default:
      return t('errors.code_generic');
  }
}

/**
 * Rewrites raw technical error text into user-friendly localized messages.
 * User-facing messages (e.g. containing Korean or already structured) are preserved untouched.
 */
export function getFriendlyErrorMessage(code: string, message: string): string {
  if (!message) return '';

  // 1. Language-independent technical markers (checked first before Hangul check,
  // so Korean Windows OS errors like "(os error 32)" or HTTP status errors are properly rewritten)

  // Windows file sharing / access violation: os error 32 / 5, "used by another process"
  if (/(?:os error 32\b|os error 5\b|used by another process|access is denied)/i.test(message)) {
    return t('errors.win_file_busy');
  }

  // DOCX 63 column limit
  if (/(?:too many columns for docx|max 63|exceeds 63 columns)/i.test(message)) {
    return t('errors.docx_cols_limit');
  }

  // Encrypted document
  if (/encrypted/i.test(message)) {
    return t('errors.encrypted_file');
  }

  // Invalid docx
  if (/not a valid docx/i.test(message)) {
    return t('errors.invalid_docx');
  }

  // SQLite busy / locked
  if (/(?:database is locked|sqlite.*busy)/i.test(message)) {
    return t('errors.sqlite_busy');
  }

  // SQLite no such table
  if (/no such table/i.test(message)) {
    return t('errors.sqlite_no_such_table');
  }

  // HTTP status 429 rate limit
  if (/(?:status\s*429\b|429\s*too\s*many)/i.test(message)) {
    return t('errors.net_rate_limit');
  }

  // HTTP status 5xx server error
  if (/(?:status\s*5\d\d\b|5\d\d\s*server\s*error|internal\s*server\s*error|bad\s*gateway|service\s*unavailable|gateway\s*timeout)/i.test(message)) {
    return t('errors.net_server_error');
  }

  // 2. Leave user-facing messages untouched (e.g. contains Hangul and didn't match technical patterns above)
  if (/[가-힣]/.test(message)) {
    return message;
  }

  // 3. Broad word patterns — only for technical error codes (IO, DB) where message is not Korean user-facing text
  const upper = (code || '').toUpperCase();
  if (upper === 'IO' || upper === 'DB') {
    // Network: timeout / timed out
    if (/(?:timed?\s*out|timeout)/i.test(message)) {
      return t('errors.net_timeout');
    }

    // Network: connection refused / dns / network error
    if (/(?:connection\s*refused|dns\b|network\b|failed\s*to\s*connect|connection\s*reset)/i.test(message)) {
      return t('errors.net_connection_failed');
    }

    // 4. Raw technical error text from IO or DB (pure ASCII / stack-like / OS error)
    return t('errors.technical_fallback');
  }

  // Otherwise, assume it's already a descriptive message written for users (e.g. VALIDATION, NOT_FOUND, NETWORK, or custom)
  return message;
}

export function formatFriendlyError(error: { code: string; message: string }): FriendlyError {
  return {
    title: getFriendlyErrorTitle(error.code),
    message: getFriendlyErrorMessage(error.code, error.message),
  };
}
