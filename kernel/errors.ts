/**
 * Pure domain error classes for kernel and protocol validation layers.
 * Uses erasable TypeScript syntax compatible with Node 24 type stripping.
 */

export class KernelError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class InputError extends KernelError {
  constructor(message: string) {
    super(message, 400, "INPUT_ERROR");
  }
}

export class AuthError extends KernelError {
  constructor(message: string) {
    super(message, 401, "AUTH_ERROR");
  }
}

export class NotFoundError extends KernelError {
  constructor(message: string) {
    super(message, 404, "NOT_FOUND");
  }
}

export class ConflictError extends KernelError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}
