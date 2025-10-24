const errors = require('./lib/errors')

const CRFL = Buffer.from('\r\n')

const BEFORE_HEAD = 1
const BODY = 2
const BEFORE_CHUNK = 3
const CHUNK = 4

const constants = {
  REQUEST: 1,
  RESPONSE: 2,
  DATA: 3,
  END: 4
}

module.exports = exports = class HTTPParser {
  constructor() {
    this._state = BEFORE_HEAD
    this._buffer = []
    this._buffered = 0
    this._remaining = -1
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
      }
    }
  }

  end() {
    return this._consume(this._buffered)
  }

  _findCRFL() {
    const buffer = this._buffer.length === 1 ? this._buffer[0] : Buffer.concat(this._buffer)

    return buffer.indexOf(CRFL)
  }

  _consume(n) {
    const buffer = this._buffer.length === 1 ? this._buffer[0] : Buffer.concat(this._buffer)

    this._buffered -= n
    this._buffer = this._buffered > 0 ? [buffer.subarray(n + CRFL.byteLength)] : []

    return buffer.subarray(0, n)
  }

  *_onbeforehead() {
    const i = this._findCRFL()
    if (i < 0) return false

    const data = this._consume(i)

    const line = data.toString('latin1')

    if (line.length === 0) throw errors.INVALID_MESSAGE()

    const headers = {}

    for (const header of this._onheader()) {
      const [name, value] = header

      if (name === null) throw errors.INVALID_HEADER()

      headers[name.toLowerCase()] = value
    }

    if (line.startsWith('HTTP/')) {
      const [version, code, ...reason] = line.split(' ')

      yield {
        type: constants.RESPONSE,
        version,
        code: parseInt(code, 10),
        reason: reason.join(' '),
        headers
      }
    } else {
      const [method, url, version] = line.split(' ')

      yield {
        type: constants.REQUEST,
        version,
        method,
        url,
        headers
      }
    }

    if (headers['transfer-encoding'] === 'chunked') {
      this._state = BEFORE_CHUNK
    } else if (headers['content-length']) {
      const length = parseInt(headers['content-length'], 10)

      if (Number.isNaN(length) || length < 0) {
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

  *_onheader() {
    while (true) {
      const data = this._consume(this._findCRFL())

      if (data.byteLength === 0) return true
      else yield splitHeader(data.toString('latin1'))
    }
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
    const i = this._findCRFL()
    if (i < 0) return false

    const data = this._consume(i)

    const length = parseInt(data.toString(), 16)

    if (Number.isNaN(length) || length < 0) {
      throw errors.INVALID_CHUNK_LENGTH()
    }

    if (length === 0) {
      this._state = BEFORE_HEAD
      this._buffer = []

      yield { type: constants.END }
    } else {
      this._state = CHUNK
      this._remaining = length
    }

    return true
  }

  *_onchunk() {
    if (this._buffered < this._remaining) return false

    const data = this._consume(this._remaining)

    this._state = BEFORE_CHUNK
    this._remaining = -1

    yield {
      type: constants.DATA,
      data
    }

    return true
  }
}

exports.constants = constants

function splitHeader(header) {
  const i = header.indexOf(': ')

  if (i === -1) return [null, null]

  return [header.slice(0, i), header.slice(i + 2)]
}
