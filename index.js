const errors = require('./lib/errors')

const DELIMITER = Buffer.from('\r\n')
const TERMINATOR = Buffer.from('\r\n\r\n')

const BEFORE_HEAD = 1
const BODY = 2
const BEFORE_CHUNK = 3
const CHUNK = 4
const AFTER_LAST_CHUNK = 5

const constants = {
  REQUEST: 1,
  RESPONSE: 2,
  DATA: 3,
  END: 4
}

module.exports = exports = class HTTPParser {
  constructor(opts = {}) {
    const { maxHeaderSize = 16384, maxHeadersCount = 2000 } = opts

    this._state = BEFORE_HEAD
    this._maxHeaderSize = maxHeaderSize
    this._maxHeadersCount = maxHeadersCount
    this._buffer = []
    this._buffered = 0
    this._remaining = -1
    this._bufferIndex = 0
    this._byteIndex = 0
    this._position = 0
    this._hits = 0
  }

  *push(data, encoding) {
    if (typeof data === 'string') data = Buffer.from(data, encoding)

    this._buffer.push(data)
    this._buffered += data.byteLength

    while (this._buffered > 0) {
      switch (this._state) {
        case BEFORE_HEAD:
          if (yield* this._onbeforehead()) continue
          else return

        case BODY:
          if (yield* this._onbody()) continue
          else return

        case BEFORE_CHUNK:
          if (yield* this._onbeforechunk()) continue
          else return

        case CHUNK:
          if (yield* this._onchunk()) continue
          else return

        case AFTER_LAST_CHUNK:
          if (yield* this._onafterlastchunk()) continue
          else return
      }
    }
  }

  end() {
    return this._consume(this._buffered)
  }

  _findSequence(sequence) {
    for (; this._bufferIndex < this._buffer.length; this._bufferIndex++) {
      const data = this._buffer[this._bufferIndex]

      for (; this._byteIndex < data.byteLength; this._byteIndex++, this._position++) {
        if (data[this._byteIndex] === sequence[this._hits]) {
          this._hits++

          if (this._hits === sequence.length) {
            const position = this._position + 1

            this._bufferIndex = 0
            this._byteIndex = 0
            this._position = 0
            this._hits = 0
            return position
          }
        } else {
          this._hits = data[this._byteIndex] === sequence[0] ? 1 : 0
        }
      }

      this._byteIndex = 0
    }

    return -1
  }

  _consume(n) {
    const buffer = this._buffer.length === 1 ? this._buffer[0] : Buffer.concat(this._buffer)

    this._buffered -= n
    this._buffer = this._buffered > 0 ? [buffer.subarray(n)] : []

    return buffer.subarray(0, n)
  }

  *_onbeforehead() {
    if (this._buffered > this._maxHeaderSize) {
      throw errors.INVALID_MESSAGE(`Header exceeds limit of ${this._maxHeaderSize} bytes`)
    }

    const i = this._findSequence(TERMINATOR)
    if (i < 0) return false

    const data = this._consume(i).subarray(0, i - TERMINATOR.byteLength)

    const lines = data.toString('latin1').split('\r\n')

    if (lines.length === 0) throw errors.INVALID_MESSAGE()

    if (lines.length >= this._maxHeadersCount) {
      throw errors.INVALID_MESSAGE(`Header count exceeds limit of ${this._maxHeadersCount}`)
    }

    const headers = {}

    for (let i = 1, n = lines.length; i < n; i++) {
      const [name, value] = splitHeader(lines[i])

      if (name === null) throw errors.INVALID_HEADER()

      if (!/^[\x21-\x7e]+$/.test(name)) throw errors.INVALID_HEADER()
      if (!/^[\x09\x20-\x7e]*$/.test(value)) throw errors.INVALID_HEADER()

      const key = name.toLowerCase()

      if ((key === 'content-length' || key === 'transfer-encoding') && key in headers) {
        throw errors.INVALID_HEADER(`Duplicate header '${name}'`)
      }

      headers[key] = value
    }

    if (lines[0].startsWith('HTTP/')) {
      let [version = null, code = null, ...reason] = lines[0].split(' ')

      if (version === null) throw errors.INVALID_MESSAGE()

      if (code === null) throw errors.INVALID_MESSAGE()

      if (!/^[0-9]+$/.test(code)) throw errors.INVALID_MESSAGE()

      code = parseInt(code, 10)

      if (!Number.isInteger(code) || code < 100 || code > 999) {
        throw errors.INVALID_MESSAGE()
      }

      yield {
        type: constants.RESPONSE,
        version,
        code,
        reason: reason.join(' '),
        headers
      }
    } else {
      const [method = null, url = null, version = null] = lines[0].split(' ')

      if (method === null) throw errors.INVALID_MESSAGE()

      if (url === null) throw errors.INVALID_MESSAGE()

      if (version === null) throw errors.INVALID_MESSAGE()

      if (version !== 'HTTP/1.0' && version !== 'HTTP/1.1') throw errors.INVALID_MESSAGE()

      if (version === 'HTTP/1.1' && 'host' in headers === false) {
        throw errors.INVALID_HEADER(`Header 'Host' is missing`)
      }

      yield {
        type: constants.REQUEST,
        version,
        method,
        url,
        headers
      }
    }

    if (headers['transfer-encoding'] && headers['transfer-encoding'].toLowerCase() === 'chunked') {
      if (headers['content-length']) {
        throw errors.INVALID_MESSAGE(`Conflicting 'Content-Length' and 'Transfer-Encoding' headers`)
      }

      this._state = BEFORE_CHUNK
    } else if (headers['content-length']) {
      let length = headers['content-length']

      if (!/^[0-9]+$/.test(length)) throw errors.INVALID_CONTENT_LENGTH()

      length = parseInt(length, 10)

      if (!Number.isInteger(length) || length < 0) {
        throw errors.INVALID_CONTENT_LENGTH()
      }

      if (length === 0) {
        yield { type: constants.END }
      } else {
        this._state = BODY
        this._remaining = length
      }
    } else {
      yield { type: constants.END }
    }

    return true
  }

  *_onbody() {
    const available = Math.min(this._buffered, this._remaining)

    this._remaining -= available

    const ended = this._remaining === 0

    const data = this._consume(available)

    if (ended) {
      this._state = BEFORE_HEAD
      this._remaining = -1
    }

    yield {
      type: constants.DATA,
      data
    }

    if (ended) yield { type: constants.END }

    return true
  }

  *_onbeforechunk() {
    const i = this._findSequence(DELIMITER)
    if (i < 0) return false

    const data = this._consume(i).subarray(0, i - DELIMITER.length)

    let length = data.toString()

    if (!/^[0-9a-fA-F]+$/.test(length)) throw errors.INVALID_CHUNK_LENGTH()

    length = parseInt(length, 16)

    if (!Number.isInteger(length) || length < 0) {
      throw errors.INVALID_CHUNK_LENGTH()
    }

    if (length === 0) {
      this._state = AFTER_LAST_CHUNK
    } else {
      this._state = CHUNK
      this._remaining = length + DELIMITER.byteLength
    }

    return true
  }

  *_onchunk() {
    if (this._buffered < this._remaining) return false

    const data = this._consume(this._remaining).subarray(0, this._remaining - DELIMITER.byteLength)

    this._state = BEFORE_CHUNK
    this._remaining = -1

    yield {
      type: constants.DATA,
      data
    }

    return true
  }

  *_onafterlastchunk() {
    const i = this._findSequence(DELIMITER)
    if (i < 0) return false

    this._consume(i)

    this._state = BEFORE_HEAD

    yield { type: constants.END }

    return true
  }
}

exports.constants = constants

function splitHeader(header) {
  const i = header.indexOf(':')

  if (i === -1) return [null, null]

  return [header.slice(0, i), header.slice(i + 1).trimStart()]
}
