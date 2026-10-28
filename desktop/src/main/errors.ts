/**
 * The first line of an error message, without terminal color codes.
 * Playwright appends a call log with the request headers, cookies included, after the first line.
 */
export function errorLine(message: string): string {
  return message.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map(line => line.trim()).find(Boolean) ?? '処理に失敗しました';
}
