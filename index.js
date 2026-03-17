const errors = require('./lib/errors')

const constants = {
  REQUEST: 1,
  RESPONSE: 2,
  DATA: 3,
  END: 4
}

const TAB = 0x09
const LF = 0x0a
const CR = 0x0d
const SP = 0x20
const ZERO = 0x30
const NINE = 0x39
const UPPER_A = 0x41
const UPPER_F = 0x46
const UPPER_Z = 0x5a
const LOWER_A = 0x61
const LOWER_F = 0x66
const COLON = 0x3a

const MAX_CHUNK_SIZE_LENGTH = 16

// Header states
const FIRST_TOKEN = 0
const REQUEST_URL = 1
const REQUEST_VERSION = 2
const STATUS_CODE = 3
const STATUS_REASON = 4
const FIRST_LINE_LF = 5
const HEADER_START = 6
const HEADER_NAME = 7
const HEADER_VALUE_WS = 8
const HEADER_VALUE = 9
const HEADER_LINE_LF = 10
const HEADER_END_LF = 11

// Body states
const BODY = 12
const CHUNK_SIZE = 13
const CHUNK_SIZE_LF = 14
const CHUNK_DATA = 15
const CHUNK_EXTENSION = 16

// Trailing states
const LAST_CHUNK_LF = 17
const TRAILER_CR = 18
const TRAILER_LF = 19

module.exports = exports = class HTTPParser {
  constructor(opts = {}) {
    const { maxHeaderSize = 16384, maxHeadersCount = 2000 } = opts

    this._maxHeaderSize = maxHeaderSize
    this._maxHeadersCount = maxHeadersCount
    this._state = FIRST_TOKEN
    this._buffer = []
    this._bufferIndex = 0
    this._byteIndex = 0
    this._buffered = 0
    this._accumulator = []

    this._isResponse = false
    this._method = ''
    this._url = ''
    this._version = ''
    this._code = 0
    this._reason = ''

    this._headerName = ''
    this._headers = {}
    this._headerCount = 0
    this._headerSize = 0

    this._remaining = 0
  }

  *push(data, encoding) {
    if (typeof data === 'string') data = Buffer.from(data, encoding)

    this._buffer.push(data)
    this._buffered += data.byteLength

    yield* this._parse()

    this._compact()
  }

  end() {
    const buffers = this._buffer
    const bufferIndex = this._bufferIndex
    const byteIndex = this._byteIndex

    this._buffer = []
    this._bufferIndex = 0
    this._byteIndex = 0
    this._buffered = 0

    if (bufferIndex >= buffers.length) return Buffer.alloc(0)

    buffers[bufferIndex] = buffers[bufferIndex].subarray(byteIndex)

    const remaining = buffers.slice(bufferIndex)

    if (remaining.length === 0) return Buffer.alloc(0)
    if (remaining.length === 1) return remaining[0]

    return Buffer.concat(remaining)
  }

  _compact() {
    if (this._bufferIndex > 0) {
      this._buffer = this._buffer.slice(this._bufferIndex)
      this._bufferIndex = 0
    }

    if (this._byteIndex > 0 && this._buffer.length > 0) {
      this._buffer[0] = this._buffer[0].subarray(this._byteIndex)
      this._byteIndex = 0
    }
  }

  _consume(n) {
    this._buffered -= n

    const current = this._buffer[this._bufferIndex]

    if (this._byteIndex + n <= current.byteLength) {
      const slice = current.subarray(this._byteIndex, this._byteIndex + n)

      this._byteIndex += n

      if (this._byteIndex >= current.byteLength) {
        this._bufferIndex++
        this._byteIndex = 0
      }

      return slice
    }

    const result = Buffer.allocUnsafe(n)

    let written = 0

    while (written < n) {
      const buffer = this._buffer[this._bufferIndex]
      const available = buffer.byteLength - this._byteIndex
      const take = Math.min(available, n - written)

      buffer.copy(result, written, this._byteIndex, this._byteIndex + take)

      written += take

      this._byteIndex += take

      if (this._byteIndex >= buffer.byteLength) {
        this._bufferIndex++
        this._byteIndex = 0
      }
    }

    return result
  }

  _buildString() {
    const string = String.fromCharCode.apply(null, this._accumulator)

    this._accumulator = []

    return string
  }

  _checkHeaderSize() {
    if (++this._headerSize > this._maxHeaderSize) {
      throw errors.INVALID_MESSAGE('Header exceeds limit of ' + this._maxHeaderSize + ' bytes')
    }
  }

  _storeHeader(name, value) {
    let end = value.length

    while (end > 0 && (value.charCodeAt(end - 1) === SP || value.charCodeAt(end - 1) === TAB)) {
      end--
    }

    if (end < value.length) value = value.substring(0, end)

    this._headerCount++

    if (this._headerCount > this._maxHeadersCount) {
      throw errors.INVALID_MESSAGE('Header count exceeds limit of ' + this._maxHeadersCount)
    }

    switch (name) {
      case '__proto__':
      case 'constructor':
      case 'prototype':
        throw errors.INVALID_HEADER("Unsafe header name '" + name + "'")

      case 'host':
      case 'content-length':
      case 'transfer-encoding':
        if (name in this._headers) {
          throw errors.INVALID_HEADER("Duplicate header '" + name + "'")
        }

        this._headers[name] = value
        break

      default:
        const delimiter = name === 'cookie' ? '; ' : ', '

        if (name in this._headers) {
          this._headers[name] += delimiter + value
        } else {
          this._headers[name] = value
        }
    }
  }

  *_parse() {
    while (true) {
      if (this._state === BODY) {
        if (this._buffered === 0) return

        const available = Math.min(this._buffered, this._remaining)
        const data = this._consume(available)

        this._remaining -= available

        const ended = this._remaining === 0

        if (ended) this._state = FIRST_TOKEN

        yield { type: constants.DATA, data }

        if (ended) yield { type: constants.END }

        continue
      }

      if (this._state === CHUNK_DATA) {
        if (this._buffered < this._remaining) return

        const consumed = this._consume(this._remaining)

        if (consumed[this._remaining - 2] !== CR || consumed[this._remaining - 1] !== LF) {
          throw errors.INVALID_MESSAGE('Expected CRLF after chunk data')
        }

        const data = consumed.subarray(0, this._remaining - 2)

        this._remaining = 0
        this._state = CHUNK_SIZE

        yield { type: constants.DATA, data }

        continue
      }

      if (this._buffered === 0) return

      const byte = this._buffer[this._bufferIndex][this._byteIndex++]

      this._buffered--

      if (this._byteIndex >= this._buffer[this._bufferIndex].byteLength) {
        this._bufferIndex++
        this._byteIndex = 0
      }

      switch (this._state) {
        case FIRST_TOKEN: {
          this._checkHeaderSize()

          if (byte === SP) {
            const token = this._buildString()

            if (token.length === 0) throw errors.INVALID_MESSAGE()

            this._isResponse = token.startsWith('HTTP/')

            if (this._isResponse) {
              if (token !== 'HTTP/1.0' && token !== 'HTTP/1.1') {
                throw errors.INVALID_MESSAGE()
              }

              this._version = token
              this._state = STATUS_CODE
            } else {
              this._method = token
              this._state = REQUEST_URL
            }
          } else if (byte === CR) {
            throw errors.INVALID_MESSAGE()
          } else if (isTokenByte(byte)) {
            this._accumulator.push(byte)
          } else if (
            byte === 0x2f &&
            this._accumulator.length === 4 &&
            this._accumulator[0] === 0x48 &&
            this._accumulator[1] === 0x54 &&
            this._accumulator[2] === 0x54 &&
            this._accumulator[3] === 0x50
          ) {
            this._accumulator.push(byte)
          } else {
            throw errors.INVALID_MESSAGE()
          }

          break
        }

        case REQUEST_URL: {
          this._checkHeaderSize()

          if (byte === SP) {
            this._url = this._buildString()

            if (this._url.length === 0) throw errors.INVALID_MESSAGE()

            this._state = REQUEST_VERSION
          } else if (byte === CR) {
            throw errors.INVALID_MESSAGE()
          } else if (byte >= 0x21 && byte !== 0x7f) {
            this._accumulator.push(byte)
          } else {
            throw errors.INVALID_MESSAGE()
          }

          break
        }

        case REQUEST_VERSION: {
          this._checkHeaderSize()

          if (byte === CR) {
            this._version = this._buildString()

            if (this._version !== 'HTTP/1.0' && this._version !== 'HTTP/1.1') {
              throw errors.INVALID_MESSAGE()
            }

            this._state = FIRST_LINE_LF
          } else if (byte >= 0x21 && byte !== 0x7f) {
            this._accumulator.push(byte)
          } else {
            throw errors.INVALID_MESSAGE()
          }

          break
        }

        case STATUS_CODE: {
          this._checkHeaderSize()

          if (byte === SP) {
            if (this._accumulator.length === 0) throw errors.INVALID_MESSAGE()

            let code = 0

            for (let i = 0, n = this._accumulator.length; i < n; i++) {
              code = code * 10 + this._accumulator[i]
            }

            this._accumulator = []

            if (code < 100 || code > 999) throw errors.INVALID_MESSAGE()

            this._code = code
            this._state = STATUS_REASON
          } else if (byte >= ZERO && byte <= NINE) {
            this._accumulator.push(byte - ZERO)
          } else {
            throw errors.INVALID_MESSAGE()
          }

          break
        }

        case STATUS_REASON: {
          this._checkHeaderSize()

          if (byte === CR) {
            this._reason = this._buildString()
            this._state = FIRST_LINE_LF
          } else if (isFieldByte(byte)) {
            this._accumulator.push(byte)
          } else {
            throw errors.INVALID_MESSAGE()
          }

          break
        }

        case FIRST_LINE_LF: {
          if (byte !== LF) throw errors.INVALID_MESSAGE()

          this._headers = {}
          this._headerCount = 0
          this._state = HEADER_START

          break
        }

        case HEADER_START: {
          this._checkHeaderSize()

          if (byte === CR) {
            this._state = HEADER_END_LF
          } else if (byte !== COLON && isTokenByte(byte)) {
            this._accumulator.push(byte >= UPPER_A && byte <= UPPER_Z ? byte + 0x20 : byte)
            this._state = HEADER_NAME
          } else {
            throw errors.INVALID_HEADER()
          }

          break
        }

        case HEADER_NAME: {
          this._checkHeaderSize()

          if (byte === COLON) {
            this._headerName = this._buildString()
            this._state = HEADER_VALUE_WS
          } else if (byte !== COLON && isTokenByte(byte)) {
            this._accumulator.push(byte >= UPPER_A && byte <= UPPER_Z ? byte + 0x20 : byte)
          } else {
            throw errors.INVALID_HEADER()
          }

          break
        }

        case HEADER_VALUE_WS: {
          this._checkHeaderSize()

          if (byte === SP || byte === TAB) break

          if (byte === CR) {
            this._storeHeader(this._headerName, '')
            this._headerName = ''
            this._state = HEADER_LINE_LF

            break
          }

          if (!isFieldByte(byte)) throw errors.INVALID_HEADER()

          this._accumulator.push(byte)
          this._state = HEADER_VALUE

          break
        }

        case HEADER_VALUE: {
          this._checkHeaderSize()

          if (byte === CR) {
            this._storeHeader(this._headerName, this._buildString())
            this._headerName = ''
            this._state = HEADER_LINE_LF
          } else if (isFieldByte(byte)) {
            this._accumulator.push(byte)
          } else {
            throw errors.INVALID_HEADER()
          }

          break
        }

        case HEADER_LINE_LF: {
          if (byte !== LF) throw errors.INVALID_HEADER()

          this._state = HEADER_START

          break
        }

        case HEADER_END_LF: {
          if (byte !== LF) throw errors.INVALID_MESSAGE()

          const headers = this._headers

          if (this._isResponse) {
            yield {
              type: constants.RESPONSE,
              version: this._version,
              code: this._code,
              reason: this._reason,
              headers
            }
          } else {
            if (this._version === 'HTTP/1.1' && !('host' in headers)) {
              throw errors.INVALID_HEADER("Header 'Host' is missing")
            }

            yield {
              type: constants.REQUEST,
              version: this._version,
              method: this._method,
              url: this._url,
              headers
            }
          }

          const transferEncoding = headers['transfer-encoding']
          const contentLength = headers['content-length']

          const encodings = transferEncoding ? transferEncoding.split(',') : null

          const lastEncoding = encodings
            ? encodings[encodings.length - 1].trim().toLowerCase()
            : null

          if (lastEncoding === 'chunked') {
            if (contentLength) {
              throw errors.INVALID_MESSAGE(
                "Conflicting 'Content-Length' and 'Transfer-Encoding' headers"
              )
            }

            this._state = CHUNK_SIZE
            this._headerSize = 0

            continue
          }

          if (contentLength) {
            if (contentLength.length === 0) throw errors.INVALID_CONTENT_LENGTH()

            let length = 0

            for (let i = 0, n = contentLength.length; i < n; i++) {
              const c = contentLength.charCodeAt(i)

              if (c < ZERO || c > NINE) throw errors.INVALID_CONTENT_LENGTH()

              length = length * 10 + (c - ZERO)
            }

            if (!Number.isSafeInteger(length) || length < 0) {
              throw errors.INVALID_CONTENT_LENGTH()
            }

            if (length === 0) {
              this._state = FIRST_TOKEN
              this._headerSize = 0

              yield { type: constants.END }
            } else {
              this._state = BODY
              this._remaining = length
              this._headerSize = 0
            }
          } else {
            this._state = FIRST_TOKEN
            this._headerSize = 0

            yield { type: constants.END }
          }

          break
        }

        case CHUNK_SIZE: {
          if (byte === CR || byte === 0x3b) {
            if (this._accumulator.length === 0) throw errors.INVALID_CHUNK_LENGTH()

            let length = 0

            for (let i = 0, n = this._accumulator.length; i < n; i++) {
              length = length * 16 + this._accumulator[i]
            }

            this._accumulator = []

            if (!Number.isSafeInteger(length)) throw errors.INVALID_CHUNK_LENGTH()

            if (byte === 0x3b) {
              this._remaining = length
              this._state = CHUNK_EXTENSION
            } else if (length === 0) {
              this._state = LAST_CHUNK_LF
            } else {
              this._remaining = length + 2
              this._state = CHUNK_SIZE_LF
            }
          } else if (isHex(byte)) {
            if (this._accumulator.length >= MAX_CHUNK_SIZE_LENGTH) {
              throw errors.INVALID_CHUNK_LENGTH()
            }

            this._accumulator.push(hexValue(byte))
          } else {
            throw errors.INVALID_CHUNK_LENGTH()
          }

          break
        }

        case CHUNK_EXTENSION: {
          this._checkHeaderSize()

          if (byte === CR) {
            if (this._remaining === 0) {
              this._state = LAST_CHUNK_LF
            } else {
              this._remaining += 2
              this._state = CHUNK_SIZE_LF
            }
          } else if (!isFieldByte(byte)) {
            throw errors.INVALID_CHUNK_LENGTH()
          }

          break
        }

        case CHUNK_SIZE_LF: {
          if (byte !== LF) throw errors.INVALID_CHUNK_LENGTH()

          this._state = CHUNK_DATA

          break
        }

        case LAST_CHUNK_LF: {
          if (byte !== LF) throw errors.INVALID_CHUNK_LENGTH()

          this._state = TRAILER_CR

          break
        }

        case TRAILER_CR: {
          if (byte !== CR) throw errors.INVALID_MESSAGE()

          this._state = TRAILER_LF

          break
        }

        case TRAILER_LF: {
          if (byte !== LF) throw errors.INVALID_MESSAGE()

          this._state = FIRST_TOKEN
          this._headerSize = 0

          yield { type: constants.END }

          break
        }

        default:
          throw errors.INVALID_MESSAGE()
      }
    }
  }
}

exports.constants = constants

const TOKEN_BYTES = Buffer.from([
  // 0x00-0x1f (control characters) + 0x20 (space)
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // 0x21-0x41: ! " # $ % & ' ( ) * + , - . / 0-9 : ; < = > ? @ A
  1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1,
  // 0x42-0x62: B-Z [ \ ] ^ _ ` a b
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1,
  // 0x63-0x7f: c-z { | } ~ DEL
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0
])

function isTokenByte(b) {
  return TOKEN_BYTES[b] === 1
}

function isFieldByte(b) {
  return b === TAB || (b >= 0x20 && b <= 0x7e)
}

function isHex(b) {
  return (
    (b >= ZERO && b <= NINE) || (b >= UPPER_A && b <= UPPER_F) || (b >= LOWER_A && b <= LOWER_F)
  )
}

function hexValue(b) {
  if (b >= ZERO && b <= NINE) return b - ZERO
  if (b >= UPPER_A && b <= UPPER_F) return b - UPPER_A + 10
  return b - LOWER_A + 10
}
