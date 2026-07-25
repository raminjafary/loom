import { ValidationError } from './errors.js'

const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/

export const normalizeChannelName = (raw: string): string => {
  const name = raw.trim().toLowerCase().replace(/\s+/g, '-')
  if (!CHANNEL_NAME.test(name)) {
    throw new ValidationError(
      'Channel name must be 2-64 chars, lowercase letters, digits or hyphens, and start with a letter or digit',
    )
  }
  return name
}

export const MAX_MESSAGE_LENGTH = 16_000

export const validateMessageText = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new ValidationError('Message cannot be empty')
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`Message exceeds ${MAX_MESSAGE_LENGTH} characters`)
  }
  return trimmed
}
