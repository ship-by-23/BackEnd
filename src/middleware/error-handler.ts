import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../lib/errors.js";

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new AppError(404, "NOT_FOUND", "The requested resource was not found."));
};

export const errorHandler: ErrorRequestHandler = (
  error,
  request,
  response,
  _next,
) => {
  if (error instanceof AppError) {
    const fields = error.fields ? { fields: error.fields } : {};
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...fields,
      },
    });
    return;
  }

  request.log.error({ err: error }, "Unhandled request error");
  response.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    },
  });
};
