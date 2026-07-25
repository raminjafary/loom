export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} not found`, 'NOT_FOUND')
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Not permitted') {
    super(message, 'FORBIDDEN')
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION')
  }
}
