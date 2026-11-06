export class AppError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function publicError(error: unknown): { status: number; error: string } {
  if (error instanceof AppError) return { status: error.status, error: error.message };
  return { status: 500, error: 'Не удалось выполнить действие. Проверьте подключение и повторите попытку.' };
}
