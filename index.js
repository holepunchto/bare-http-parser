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
const SEMICOLON = 0x3b
const SLASH = 0x2f

const MAX_CHUNK_SIZE_LENGTH = 16
const STATUS_CODE_LENGTH = 3

const MAX_APPLY_LENGTH = 4096

// Header states
const FIRST_TOKEN = 0
const LEADING_LINE_LF = 1
const REQUEST_URL = 2
const REQUEST_VERSION = 3
const STATUS_CODE = 4
const STATUS_REASON = 5
const FIRST_LINE_LF = 6
const HEADER_START = 7
const HEADER_NAME = 8
const HEADER_VALUE_WS = 9
const HEADER_VALUE = 10
const HEADER_LINE_LF = 11
const HEADER_END_LF = 12

// Body states
const BODY = 13
const BODY_EOF = 14
const CHUNK_SIZE = 15
const CHUNK_SIZE_LF = 16
const CHUNK_DATA = 17
const CHUNK_DATA_CR = 18
const CHUNK_DATA_LF = 19
const CHUNK_EXTENSION = 20

// Trailing states
const LAST_CHUNK_LF = 21
const TRAILER_START = 22
const TRAILER_NAME = 23
const TRAILER_VALUE = 24
const TRAILER_LINE_LF = 25
const TRAILER_END_LF = 26

// The connection has been handed over to another protocol and the remaining
// bytes are no longer ours to parse.
const TUNNEL = 27

const METHODS = new Set([
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'QUERY',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE'
])

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
    this._fatal = null

    this._isResponse = false
    this._method = ''
    this._url = ''
    this._version = ''
    this._code = 0
    this._reason = ''

    this._headerName = ''
    this._headers = Object.create(null)
    this._headerCount = 0
    this._headerSize = 0

    this._remaining = 0
    this._skipBody = false
  }

  skipBody() {
    this._skipBody = true
  }

  *push(data, encoding) {
    if (this._fatal !== null) throw this._fatal

    if (typeof data === 'string') data = Buffer.from(data, encoding)

    if (data.byteLength > 0) {
      this._buffer.push(data)
      this._buffered += data.byteLength
    }

    try {
      yield* this._parse()
    } catch (err) {
      this._fatal = err
      throw err
    }

    this._compact()
  }

  *end() {
    if (this._fatal !== null) throw this._fatal

    const state = this._state
    const pending = this._accumulator.length > 0

    this._state = FIRST_TOKEN
    this._accumulator = []
    this._headerName = ''
    this._headerSize = 0
    this._remaining = 0
    this._skipBody = false

    if (state === BODY_EOF) {
      yield { type: constants.END }

      return
    }

    if (state === TUNNEL || (state === FIRST_TOKEN && pending === false)) return

    this._fatal = errors.INVALID_MESSAGE('Message truncated by end of stream')

    throw this._fatal
  }

  drain() {
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
    const accumulator = this._accumulator

    this._accumulator = []

    if (accumulator.length <= MAX_APPLY_LENGTH) {
      return String.fromCharCode.apply(null, accumulator)
    }

    let string = ''

    for (let i = 0, n = accumulator.length; i < n; i += MAX_APPLY_LENGTH) {
      string += String.fromCharCode.apply(null, accumulator.slice(i, i + MAX_APPLY_LENGTH))
    }

    return string
  }

  // Zero turns a limit off, as a caller that wants no limit has no other way of
  // saying so and would otherwise get one that refuses every message.
  _checkHeaderSize() {
    if (this._maxHeaderSize === 0) return

    if (++this._headerSize > this._maxHeaderSize) {
      throw errors.HEADER_OVERFLOW('Header exceeds limit of ' + this._maxHeaderSize + ' bytes')
    }
  }

  _checkHeaderCount() {
    if (this._maxHeadersCount === 0) return

    if (++this._headerCount > this._maxHeadersCount) {
      throw errors.HEADER_OVERFLOW('Header count exceeds limit of ' + this._maxHeadersCount)
    }
  }

  _storeHeader(name, value) {
    let end = value.length

    while (end > 0 && (value.charCodeAt(end - 1) === SP || value.charCodeAt(end - 1) === TAB)) {
      end--
    }

    if (end < value.length) value = value.substring(0, end)

    this._checkHeaderCount()

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

      case 'set-cookie':
        if (name in this._headers) this._headers[name].push(value)
        else this._headers[name] = [value]
        break

      default: {
        const delimiter = name === 'cookie' ? '; ' : ', '

        if (name in this._headers) {
          this._headers[name] += delimiter + value
        } else {
          this._headers[name] = value
        }
      }
    }
  }

  _checkTrailer(name) {
    switch (name) {
      // A trailer arrives after the headers have already been surfaced, so a
      // framing or routing header here could never be acted upon and is only
      // ever an attempt to smuggle one past the consumer.
      case 'host':
      case 'content-length':
      case 'transfer-encoding':
        throw errors.INVALID_HEADER("Header '" + name + "' must not appear in a trailer")
    }

    this._checkHeaderCount()
  }

  *_parse() {
    while (true) {
      if (this._state === TUNNEL) return

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

      if (this._state === BODY_EOF) {
        if (this._buffered === 0) return

        yield { type: constants.DATA, data: this._consume(this._buffered) }

        continue
      }

      if (this._state === CHUNK_DATA) {
        if (this._buffered === 0) return

        const available = Math.min(this._buffered, this._remaining)
        const data = this._consume(available)

        this._remaining -= available

        if (this._remaining === 0) this._state = CHUNK_DATA_CR

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
              if (METHODS.has(token) === false) {
                throw errors.INVALID_METHOD("Unsupported method '" + token + "'")
              }

              this._method = token
              this._state = REQUEST_URL
            }
          } else if (byte === CR) {
            // RFC 9112 asks that an empty line before the start line be
            // ignored, since a peer that ends a message with a stray CRLF
            // leaves one behind. How many may be spent is bounded by the
            // header size, which counts them like any other byte.
            if (this._accumulator.length > 0) throw errors.INVALID_MESSAGE()

            this._state = LEADING_LINE_LF
          } else if (isTokenByte(byte)) {
            this._accumulator.push(byte)
          } else if (
            byte === SLASH &&
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

        case LEADING_LINE_LF: {
          if (byte !== LF) throw errors.INVALID_MESSAGE()

          this._state = FIRST_TOKEN

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
          } else if (isVisibleByte(byte)) {
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
          } else if (isVisibleByte(byte)) {
            this._accumulator.push(byte)
          } else {
            throw errors.INVALID_MESSAGE()
          }

          break
        }

        case STATUS_CODE: {
          this._checkHeaderSize()

          if (byte === SP || byte === CR) {
            // RFC 9112 fixes the status code at exactly three digits, which
            // also rules out the leading zeroes that would let a peer dress one
            // code up as another.
            if (this._accumulator.length !== STATUS_CODE_LENGTH) {
              throw errors.INVALID_MESSAGE()
            }

            let code = 0

            for (let i = 0; i < STATUS_CODE_LENGTH; i++) {
              code = code * 10 + this._accumulator[i]
            }

            this._accumulator = []

            if (code < 100) throw errors.INVALID_MESSAGE()

            this._code = code

            // The space and the reason phrase after it are both routinely left
            // out in practice, even though RFC 9112 requires the space.
            if (byte === CR) {
              this._reason = ''
              this._state = FIRST_LINE_LF
            } else {
              this._state = STATUS_REASON
            }
          } else if (byte >= ZERO && byte <= NINE) {
            if (this._accumulator.length === STATUS_CODE_LENGTH) {
              throw errors.INVALID_MESSAGE()
            }

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

          this._headers = Object.create(null)
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

          const headers = Object.assign(Object.create(null), this._headers)

          if (!this._isResponse && this._version === 'HTTP/1.1' && !('host' in headers)) {
            throw errors.INVALID_HEADER("Header 'Host' is missing")
          }

          // Resolve the framing before the message is surfaced so that a
          // consumer never gets to act on a message we go on to reject.
          const transferEncoding = headers['transfer-encoding']
          const contentLength = headers['content-length']

          let chunked = false
          let length = -1

          // A header that is present but empty still has to be validated, so
          // test for presence rather than truthiness.
          if (transferEncoding !== undefined) {
            const encodings = transferEncoding.split(',')

            let chunkedCount = 0

            for (let i = 0, n = encodings.length; i < n; i++) {
              if (encodings[i].trim().toLowerCase() === 'chunked') chunkedCount++
            }

            const lastEncoding = encodings[encodings.length - 1].trim().toLowerCase()

            if (lastEncoding !== 'chunked') {
              throw errors.INVALID_MESSAGE("'Transfer-Encoding' must end with 'chunked'")
            }

            if (chunkedCount > 1) {
              throw errors.INVALID_MESSAGE(
                "'chunked' must not appear more than once in 'Transfer-Encoding'"
              )
            }

            if (contentLength !== undefined) {
              throw errors.INVALID_MESSAGE(
                "Conflicting 'Content-Length' and 'Transfer-Encoding' headers"
              )
            }

            // An HTTP/1.0 peer cannot be assumed to understand chunked framing,
            // so the two disagreeing about where the body ends is a smuggling
            // opportunity.
            if (this._version === 'HTTP/1.0') {
              throw errors.INVALID_MESSAGE("'Transfer-Encoding' requires HTTP/1.1")
            }

            chunked = true
          } else if (contentLength !== undefined) {
            if (contentLength.length === 0) throw errors.INVALID_CONTENT_LENGTH()

            length = 0

            for (let i = 0, n = contentLength.length; i < n; i++) {
              const c = contentLength.charCodeAt(i)

              if (c < ZERO || c > NINE) throw errors.INVALID_CONTENT_LENGTH()

              length = length * 10 + (c - ZERO)
            }

            if (!Number.isSafeInteger(length)) throw errors.INVALID_CONTENT_LENGTH()
          }

          // A response to a `HEAD` request, an informational response, and a
          // `204` or `304` response all carry no body whatever their framing
          // headers say. Reading one would consume the response that follows.
          const bodyless =
            this._isResponse &&
            (this._skipBody || this._code < 200 || this._code === 204 || this._code === 304)

          this._skipBody = false
          this._headerSize = 0

          if (this._isResponse) {
            yield {
              type: constants.RESPONSE,
              version: this._version,
              code: this._code,
              reason: this._reason,
              headers
            }
          } else {
            yield {
              type: constants.REQUEST,
              version: this._version,
              method: this._method,
              url: this._url,
              headers
            }
          }

          // A `CONNECT` request and a `101` response both hand the connection
          // over to another protocol. Stop parsing rather than misreading the
          // bytes that follow, and leave them for `end()`.
          if (this._isResponse ? this._code === 101 : this._method === 'CONNECT') {
            this._state = TUNNEL

            yield { type: constants.END }

            break
          }

          if (bodyless || length === 0) {
            this._state = FIRST_TOKEN

            yield { type: constants.END }
          } else if (chunked) {
            this._state = CHUNK_SIZE
          } else if (length > 0) {
            this._state = BODY
            this._remaining = length
          } else if (this._isResponse) {
            // A response with no framing headers runs until the connection
            // closes. Treating it as empty would turn its body into the next
            // response.
            this._state = BODY_EOF
          } else {
            this._state = FIRST_TOKEN

            yield { type: constants.END }
          }

          break
        }

        case CHUNK_SIZE: {
          if (byte === CR || byte === SEMICOLON) {
            if (this._accumulator.length === 0) throw errors.INVALID_CHUNK_LENGTH()

            let length = 0

            for (let i = 0, n = this._accumulator.length; i < n; i++) {
              length = length * 16 + this._accumulator[i]
            }

            this._accumulator = []

            if (!Number.isSafeInteger(length)) throw errors.INVALID_CHUNK_LENGTH()

            this._remaining = length

            if (byte === SEMICOLON) {
              this._state = CHUNK_EXTENSION
            } else if (length === 0) {
              this._state = LAST_CHUNK_LF
            } else {
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
            this._state = this._remaining === 0 ? LAST_CHUNK_LF : CHUNK_SIZE_LF
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

        case CHUNK_DATA_CR: {
          if (byte !== CR) throw errors.INVALID_MESSAGE('Expected CRLF after chunk data')

          this._state = CHUNK_DATA_LF

          break
        }

        case CHUNK_DATA_LF: {
          if (byte !== LF) throw errors.INVALID_MESSAGE('Expected CRLF after chunk data')

          this._state = CHUNK_SIZE
          this._headerSize = 0

          break
        }

        case LAST_CHUNK_LF: {
          if (byte !== LF) throw errors.INVALID_CHUNK_LENGTH()

          this._state = TRAILER_START

          break
        }

        case TRAILER_START: {
          this._checkHeaderSize()

          if (byte === CR) {
            this._state = TRAILER_END_LF
          } else if (byte !== COLON && isTokenByte(byte)) {
            this._accumulator.push(byte >= UPPER_A && byte <= UPPER_Z ? byte + 0x20 : byte)
            this._state = TRAILER_NAME
          } else {
            throw errors.INVALID_HEADER()
          }

          break
        }

        case TRAILER_NAME: {
          this._checkHeaderSize()

          if (byte === COLON) {
            this._checkTrailer(this._buildString())
            this._state = TRAILER_VALUE
          } else if (byte !== COLON && isTokenByte(byte)) {
            this._accumulator.push(byte >= UPPER_A && byte <= UPPER_Z ? byte + 0x20 : byte)
          } else {
            throw errors.INVALID_HEADER()
          }

          break
        }

        case TRAILER_VALUE: {
          this._checkHeaderSize()

          if (byte === CR) this._state = TRAILER_LINE_LF
          else if (!isFieldByte(byte)) throw errors.INVALID_HEADER()

          break
        }

        case TRAILER_LINE_LF: {
          if (byte !== LF) throw errors.INVALID_HEADER()

          this._state = TRAILER_START

          break
        }

        case TRAILER_END_LF: {
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
  return b === TAB || (b >= 0x20 && b <= 0x7e) || b >= 0x80
}

function isVisibleByte(b) {
  return b >= 0x21 && b <= 0x7e
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
