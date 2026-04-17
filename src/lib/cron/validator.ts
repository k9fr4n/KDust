import cronParser from 'cron-parser';

export function isValidCronExpression(expr: string): boolean {
  try {
    cronParser.parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

export function nextRunAt(expr: string, tz: string): Date | null {
  try {
    const it = cronParser.parseExpression(expr, { tz });
    return it.next().toDate();
  } catch {
    return null;
  }
}
