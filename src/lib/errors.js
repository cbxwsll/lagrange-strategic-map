import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function fail(status, code, message, details) {
  throw new HttpError(status, code, message, details);
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function errorMiddleware(error, req, res, next) { // eslint-disable-line no-unused-vars
  if (error instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '请求参数不符合要求', details: error.issues } });
  }
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'JSON 请求体格式错误' } });
  }
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
  }
  if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return res.status(409).json({ error: { code: 'CONFLICT', message: '数据与现有记录冲突' } });
  }
  console.error(`[${new Date().toISOString()}] request failed`, { method: req.method, path: req.path, message: error?.message });
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
}
