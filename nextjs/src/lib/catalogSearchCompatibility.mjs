const UNDEFINED_COLUMN = '42703'

export function isMissingColumnError(error, column) {
  if (error?.code !== UNDEFINED_COLUMN || typeof column !== 'string' || column === '') return false
  const diagnostic = [error.message, error.details]
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  return diagnostic.includes(column.toLowerCase())
}
