import { describe, it, expect, beforeEach } from 'vitest';
import { formatFriendlyError, getFriendlyErrorTitle, getFriendlyErrorMessage } from './errorText';
import { useSettingsStore } from '../stores/settings';

describe('errorText (U-4, FIX2-B)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: 'ko' });
  });

  describe('titles', () => {
    it('translates code titles to friendly localized strings', () => {
      expect(getFriendlyErrorTitle('VALIDATION')).toBe('입력 확인');
      expect(getFriendlyErrorTitle('CONFLICT')).toBe('동시 변경 충돌');
      expect(getFriendlyErrorTitle('NOT_FOUND')).toBe('찾을 수 없음');
      expect(getFriendlyErrorTitle('IO')).toBe('연결·파일 오류');
      expect(getFriendlyErrorTitle('DB')).toBe('데이터베이스 오류');
      expect(getFriendlyErrorTitle('CUSTOM')).toBe('오류');
    });

    it('works in English when uiLang is en', () => {
      useSettingsStore.setState({ uiLang: 'en' });
      expect(getFriendlyErrorTitle('VALIDATION')).toBe('Check input');
      expect(getFriendlyErrorTitle('IO')).toBe('Connection or file error');
      expect(getFriendlyErrorTitle('DB')).toBe('Database error');
    });
  });

  describe('messages', () => {
    it('leaves pure user-facing messages containing Korean untouched when no technical pattern matches', () => {
      const msg = '노트 이름을 입력해 주세요';
      expect(getFriendlyErrorMessage('VALIDATION', msg)).toBe(msg);
      const ioMsg = '파일을 저장하지 못했습니다 (용량 부족)';
      expect(getFriendlyErrorMessage('IO', ioMsg)).toBe(ioMsg);
    });

    it('rewrites Korean Windows OS error containing os error 32 / 5', () => {
      const winKoMsg = '다른 프로세스가 파일을 사용 중이기 때문에 프로세스에서 파일에 액세스할 수 없습니다. (os error 32)';
      expect(getFriendlyErrorMessage('IO', winKoMsg)).toBe('다른 앱에서 열려 있어요');
      const winKoAccessDenied = '액세스가 거부되었습니다. (os error 5)';
      expect(getFriendlyErrorMessage('IO', winKoAccessDenied)).toBe('다른 앱에서 열려 있어요');
    });

    it('rewrites rename error with Korean filename containing os error 32 / 5', () => {
      const renameMsg = "Failed to rename '회의록.hwpx': Access is denied. (os error 5)";
      expect(getFriendlyErrorMessage('IO', renameMsg)).toBe('다른 앱에서 열려 있어요');
      const renameMsg32 = "파일 '보고서.hwpx'을(를) 다른 프로세스가 사용 중입니다. (os error 32)";
      expect(getFriendlyErrorMessage('IO', renameMsg32)).toBe('다른 앱에서 열려 있어요');
    });

    it('rewrites Windows English os error 32 / 5 busy pattern', () => {
      expect(getFriendlyErrorMessage('IO', 'The process cannot access the file because it is being used by another process. (os error 32)')).toBe('다른 앱에서 열려 있어요');
      expect(getFriendlyErrorMessage('IO', 'Access is denied. (os error 5)')).toBe('다른 앱에서 열려 있어요');
    });

    it('rewrites network errors: timeout, 429, 5xx, connection refused', () => {
      expect(getFriendlyErrorMessage('IO', 'request timed out')).toBe('응답이 없어요. 잠시 후 다시 시도해 주세요');
      expect(getFriendlyErrorMessage('IO', 'timeout')).toBe('응답이 없어요. 잠시 후 다시 시도해 주세요');
      expect(getFriendlyErrorMessage('IO', 'request failed with status 429: Too Many Requests')).toBe('요청이 많아요. 잠시 후 다시 시도해 주세요');
      expect(getFriendlyErrorMessage('IO', 'HTTP status 502 Bad Gateway')).toBe('서버가 잠시 응답하지 않아요');
      expect(getFriendlyErrorMessage('IO', 'connection refused to 127.0.0.1:45123')).toBe('연결할 수 없어요');
    });

    it('rewrites DOCX 63 column limit', () => {
      expect(getFriendlyErrorMessage('VALIDATION', 'table has too many columns for DOCX (max 63)')).toBe('표의 열이 너무 많아요 (DOCX는 최대 63열)');
    });

    it('rewrites encrypted file error', () => {
      expect(getFriendlyErrorMessage('VALIDATION', 'encrypted file cannot be opened')).toBe('암호가 걸린 문서는 열 수 없어요');
    });

    it('rewrites invalid docx error', () => {
      expect(getFriendlyErrorMessage('VALIDATION', 'not a valid docx archive')).toBe('올바른 Word 문서 형식이 아니에요');
    });

    it('rewrites SQLite busy / locked error', () => {
      expect(getFriendlyErrorMessage('DB', 'database is locked')).toBe('데이터베이스가 사용 중이에요. 잠시 후 다시 시도해 주세요');
      expect(getFriendlyErrorMessage('DB', 'sqlite busy timeout')).toBe('데이터베이스가 사용 중이에요. 잠시 후 다시 시도해 주세요');
    });

    it('rewrites SQLite no such table error', () => {
      expect(getFriendlyErrorMessage('DB', 'no such table: notes_fts')).toBe('데이터베이스 형식이 맞지 않아요');
    });

    it('rewrites raw ASCII technical error from IO / DB with fallback', () => {
      expect(getFriendlyErrorMessage('IO', 'Broken pipe at line 42')).toBe('문제가 생겼어요 · 자세한 내용은 진단 탭');
      expect(getFriendlyErrorMessage('DB', 'disk I/O error')).toBe('문제가 생겼어요 · 자세한 내용은 진단 탭');
    });

    it('leaves non-IO/DB English user messages untouched even if containing words like timeout or network', () => {
      const msg1 = 'Please choose a different folder name.';
      expect(getFriendlyErrorMessage('CUSTOM', msg1)).toBe(msg1);

      const aiTimeout = 'The AI request timed out. Check your connection and try again.';
      expect(getFriendlyErrorMessage('NETWORK', aiTimeout)).toBe(aiTimeout);

      const syncWarning = 'Network address changed — turn sync off and on again.';
      expect(getFriendlyErrorMessage('VALIDATION', syncWarning)).toBe(syncWarning);
    });

    it('rewrites IO errors containing timeout to friendly message', () => {
      expect(getFriendlyErrorMessage('IO', 'timeout')).toBe('응답이 없어요. 잠시 후 다시 시도해 주세요');
      expect(getFriendlyErrorMessage('IO', 'request timed out')).toBe('응답이 없어요. 잠시 후 다시 시도해 주세요');
    });

    it('rewrites Korean Windows OS error containing (os error 32) to friendly message', () => {
      const winKo = '다른 프로세스가 파일을 사용 중이기 때문에 프로세스에서 파일에 액세스할 수 없습니다. (os error 32)';
      expect(getFriendlyErrorMessage('IO', winKo)).toBe('다른 앱에서 열려 있어요');
    });
  });

  describe('formatFriendlyError', () => {
    it('formats both title and message together', () => {
      const res = formatFriendlyError({ code: 'IO', message: 'os error 32: file is locked' });
      expect(res.title).toBe('연결·파일 오류');
      expect(res.message).toBe('다른 앱에서 열려 있어요');
    });
  });
});

