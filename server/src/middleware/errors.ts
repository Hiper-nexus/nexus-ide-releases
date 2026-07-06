import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

/**
 * Express 4 não encaminha rejeição de handler async para o fluxo de erro —
 * a request fica pendurada e a promise vira unhandled rejection. Todo
 * handler async passa por asyncHandler; o errorHandler fecha em 500 JSON
 * sem vazar stack pro cliente (contexto completo vai pro log do servidor).
 */

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// A ASSINATURA de 4 argumentos é o que faz o Express tratar como middleware
// de erro — não remova o parâmetro não usado.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  console.error('[server] erro não tratado:', req.method, req.path, err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'erro interno' });
};
