const test = require('brittle')
const HTTPParser = require('.')

const {
  constants: { REQUEST, RESPONSE, DATA, END }
} = HTTPParser

function bag(fields) {
  return Object.assign(Object.create(null), fields)
}

test('request', (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Type: application/x-www-form-urlencoded\r
Content-Length: 49\r
\r
name=FirstName+LastName&email=bsmth%40example.com`

  t.alike(
    [...parser.push(input)],
    [
      {
        type: REQUEST,
        version: 'HTTP/1.1',
        method: 'POST',
        url: '/users',
        headers: bag({
          host: 'example.com',
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': '49'
        })
      },
      {
        type: DATA,
        data: Buffer.from('name=FirstName+LastName&email=bsmth%40example.com')
      },
      {
        type: END
      }
    ]
  )
})

test('request, http/1.0 missing host', (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
\r
`

  t.alike(
    [...parser.push(input)],
    [
      {
        type: REQUEST,
        version: 'HTTP/1.0',
        method: 'GET',
        url: '/users',
        headers: bag({})
      },
      {
        type: END
      }
    ]
  )
})

test('request, http/1.1 missing host', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('response', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 201 Created\r
Host: example.com\r
Content-Type: application/json\r
Content-Length: 154\r
Location: http://example.com/users/123\r
\r
{
  "message": "New user created",
  "user": {
    "id": 123,
    "firstName": "Example",
    "lastName": "Person",
    "email": "bsmth@example.com"
  }
}`

  t.alike(
    [...parser.push(input)],
    [
      {
        type: RESPONSE,
        version: 'HTTP/1.1',
        code: 201,
        reason: 'Created',
        headers: bag({
          host: 'example.com',
          'content-type': 'application/json',
          'content-length': '154',
          location: 'http://example.com/users/123'
        })
      },
      {
        type: DATA,
        data: Buffer.from(`{
  "message": "New user created",
  "user": {
    "id": 123,
    "firstName": "Example",
    "lastName": "Person",
    "email": "bsmth@example.com"
  }
}`)
      },
      {
        type: END
      }
    ]
  )
})

test('chunked response', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 201 Created\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
${(11).toString(16)}\r
First chunk\r
${(12).toString(16)}\r
Second chunk\r
0\r
\r\n`

  t.alike(
    [...parser.push(input)],
    [
      {
        type: RESPONSE,
        version: 'HTTP/1.1',
        code: 201,
        reason: 'Created',
        headers: bag({
          host: 'example.com',
          'transfer-encoding': 'chunked'
        })
      },
      {
        type: DATA,
        data: Buffer.from('First chunk')
      },
      {
        type: DATA,
        data: Buffer.from('Second chunk')
      },
      {
        type: END
      }
    ]
  )
})

test('chunked response, multiple', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 201 Created\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
${(11).toString(16)}\r
First chunk\r
${(12).toString(16)}\r
Second chunk\r
0\r
\r\n`

  t.alike(
    [...parser.push(input), ...parser.push(input)],
    [
      {
        type: RESPONSE,
        version: 'HTTP/1.1',
        code: 201,
        reason: 'Created',
        headers: bag({
          host: 'example.com',
          'transfer-encoding': 'chunked'
        })
      },
      {
        type: DATA,
        data: Buffer.from('First chunk')
      },
      {
        type: DATA,
        data: Buffer.from('Second chunk')
      },
      {
        type: END
      },
      {
        type: RESPONSE,
        version: 'HTTP/1.1',
        code: 201,
        reason: 'Created',
        headers: bag({
          host: 'example.com',
          'transfer-encoding': 'chunked'
        })
      },
      {
        type: DATA,
        data: Buffer.from('First chunk')
      },
      {
        type: DATA,
        data: Buffer.from('Second chunk')
      },
      {
        type: END
      }
    ]
  )
})

test('request, conflicting content-length and transfer-encoding', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 10\r
Transfer-Encoding: chunked\r
\r
5\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, transfer-encoding chunked case insensitive', (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: Chunked\r
\r
5\r
hello\r
0\r
\r\n`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[1].type, DATA)
  t.alike(result[1].data, Buffer.from('hello'))
  t.is(result[2].type, END)
})

test('request, header exceeds max size', async (t) => {
  const parser = new HTTPParser({ maxHeaderSize: 64 })

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
X-Large: ${'A'.repeat(100)}\r
\r
`

  await t.exception(() => [...parser.push(input)], /HEADER_OVERFLOW/)
})

test('request, too many headers', async (t) => {
  const parser = new HTTPParser({ maxHeadersCount: 3 })

  const headers = Array.from({ length: 5 }, (_, i) => `X-Header-${i}: value\r`).join('\n')

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
${headers}
\r
`

  await t.exception(() => [...parser.push(input)], /HEADER_OVERFLOW/)
})

test('request, duplicate content-length', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 5\r
Content-Length: 10\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, duplicate transfer-encoding', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
Transfer-Encoding: chunked\r
\r
5\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, invalid header name', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
Invalid Header: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, null byte in header name', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /users HTTP/1.1\r\nHost: example.com\r\nX-Bad'),
    Buffer.from([0x00]),
    Buffer.from(': value\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, header without space after colon', (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host:example.com\r
Content-Length: 0\r
\r
`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers.host, 'example.com')
})

test('request, content-length with trailing garbage', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 5abc\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID_CONTENT_LENGTH/)
})

test('request, chunk length with trailing garbage', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
5xyz\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, terminator split across pushes', (t) => {
  const head = 'GET / HTTP/1.0\r\nX-Foo: bar\r\n'
  const terminator = '\r\n'

  for (let i = 1; i < terminator.length; i++) {
    const parser = new HTTPParser()

    const result = [
      ...parser.push(Buffer.from(head + terminator.slice(0, i))),
      ...parser.push(Buffer.from(terminator.slice(i)))
    ]

    t.is(result[0].type, REQUEST)
    t.is(result[0].headers['x-foo'], 'bar')
  }
})

test('request, partial terminator match resets across pushes', (t) => {
  const parser = new HTTPParser()

  const result = [
    ...parser.push(Buffer.from('GET / HTTP/1.0\r\n')),
    ...parser.push(Buffer.from('X-Foo: bar\r\n')),
    ...parser.push(Buffer.from('\r\n'))
  ]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers['x-foo'], 'bar')
})

test('request, header size exceeded across multiple pushes', async (t) => {
  const parser = new HTTPParser({ maxHeaderSize: 64 })

  const result = []

  for (const msg of parser.push(Buffer.from('GET / HTTP/1.0\r\n'))) {
    result.push(msg)
  }

  for (const msg of parser.push(Buffer.from('X-A: value\r\n'))) {
    result.push(msg)
  }

  await t.exception(() => {
    for (const msg of parser.push(Buffer.from('X-Pad: ' + 'A'.repeat(30) + '\r\n\r\n'))) {
      result.push(msg)
    }
  }, /HEADER_OVERFLOW/)
})

test('request, chunk length with leading whitespace', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
 5\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, chunk length with trailing whitespace', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
5 \r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('response, non-numeric status code', async (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 abc OK\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('response, status code out of range', async (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 99999 OK\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, missing url and version', async (t) => {
  const parser = new HTTPParser()

  const input = `GET\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, missing version', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /path\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, null byte in header value', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /users HTTP/1.1\r\nHost: example.com\r\nX-Bad: val'),
    Buffer.from([0x00]),
    Buffer.from('ue\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, control character in header value', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /users HTTP/1.1\r\nHost: example.com\r\nX-Bad: val'),
    Buffer.from([0x01]),
    Buffer.from('ue\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, byte by byte', (t) => {
  const parser = new HTTPParser()

  const input = Buffer.from(
    'POST /users HTTP/1.1\r\nHost: example.com\r\nContent-Length: 5\r\n\r\nhello'
  )

  const result = []

  for (let i = 0; i < input.byteLength; i++) {
    for (const msg of parser.push(input.subarray(i, i + 1))) {
      result.push(msg)
    }
  }

  t.is(result[0].type, REQUEST)
  t.is(result[0].method, 'POST')
  t.is(result[result.length - 1].type, END)

  const body = Buffer.concat(result.filter((m) => m.type === DATA).map((m) => m.data))
  t.alike(body, Buffer.from('hello'))
})

test('drain, returns remaining after upgrade', (t) => {
  const parser = new HTTPParser()

  const input =
    'GET /chat HTTP/1.1\r\n' +
    'Host: example.com\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    '\r\n' +
    'websocket-frame-data-here'

  const it = parser.push(input)

  const header = it.next()
  t.is(header.value.type, REQUEST)
  t.is(header.value.headers.upgrade, 'websocket')

  const end = it.next()
  t.is(end.value.type, END)

  const remaining = parser.drain()
  t.alike(remaining, Buffer.from('websocket-frame-data-here'))
})

test('drain, returns body when generator abandoned after header', (t) => {
  const parser = new HTTPParser()

  const input =
    'POST /upload HTTP/1.1\r\n' +
    'Host: example.com\r\n' +
    'Content-Length: 11\r\n' +
    '\r\n' +
    'hello world'

  const it = parser.push(input)

  const header = it.next()
  t.is(header.value.type, REQUEST)

  const remaining = parser.drain()
  t.alike(remaining, Buffer.from('hello world'))
})

test('request, chunk size exceeds safe integer', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
fffffffffffffffff\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, chunk size exceeds max length', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
${'a'.repeat(17)}\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, content-length exceeds safe integer', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 9007199254740993\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID_CONTENT_LENGTH/)
})

test('request, chunk data missing CRLF terminator', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from(
      'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n'
    ),
    Buffer.from('helloXX'),
    Buffer.from('0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, __proto__ header rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
__proto__: polluted\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, constructor header rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
constructor: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, prototype header rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
prototype: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

// Rejecting the three names that reach `Object.prototype` only helps if the bag
// they would have reached it through has no prototype to begin with. A consumer
// that looks up a header name the peer chose must be told the header is absent,
// not handed whatever `Object.prototype` happens to carry under that name.
test('request, headers are surfaced without a prototype', (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
\r
`

  const [{ headers }] = [...parser.push(input)]

  t.is(Object.getPrototypeOf(headers), null, 'no prototype')

  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    t.is(headers[name], undefined, name + ' reads as absent')
    t.absent(name in headers, name + ' is not present')
  }
})

test('response, headers are surfaced without a prototype', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 200 OK\r
Content-Length: 0\r
\r
`

  const [{ headers }] = [...parser.push(input)]

  t.is(Object.getPrototypeOf(headers), null, 'no prototype')
  t.is(headers.constructor, undefined, 'constructor reads as absent')
})

// Each message gets a bag of its own, so that one a consumer is still holding
// cannot be changed underneath it by whatever the peer sends next.
test('request, headers are not shared between messages', (t) => {
  const parser = new HTTPParser()

  const input = `GET /a HTTP/1.1\r
Host: a.example.com\r
\r
GET /b HTTP/1.1\r
Host: b.example.com\r
\r
`

  const result = [...parser.push(input)]

  t.not(result[0].headers, result[2].headers, 'a bag each')
  t.is(result[0].headers.host, 'a.example.com', 'first left as it was')
  t.is(result[2].headers.host, 'b.example.com', 'second read separately')
})

test('request, duplicate headers combined with comma', (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
X-Forwarded-For: 1.1.1.1\r
X-Forwarded-For: 2.2.2.2\r
\r
`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers['x-forwarded-for'], '1.1.1.1, 2.2.2.2')
})

test('request, stacked transfer-encoding with chunked last', (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: gzip, chunked\r
\r
5\r
hello\r
0\r
\r\n`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[1].type, DATA)
  t.alike(result[1].data, Buffer.from('hello'))
  t.is(result[2].type, END)
})

test('request, stacked transfer-encoding without chunked last', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked, gzip\r
Content-Length: 5\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID_MESSAGE/)
})

test('request, transfer-encoding without chunked', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: gzip\r
Content-Length: 5\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID_MESSAGE/)
})

test('request, transfer-encoding identity rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: identity\r
Content-Length: 5\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID_MESSAGE/)
})

test('request, transfer-encoding chunked appearing twice', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked, gzip, chunked\r
\r
5\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_MESSAGE/)
})

test('request, separator chars rejected in header name', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
X[Bad]: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, parentheses rejected in header name', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
X(Bad): value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, at-sign rejected in header name', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
X@Bad: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, max headers count boundary', (t) => {
  const parser = new HTTPParser({ maxHeadersCount: 3 })

  const input = `GET /users HTTP/1.0\r
X-A: 1\r
X-B: 2\r
X-C: 3\r
\r
`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers['x-a'], '1')
  t.is(result[0].headers['x-b'], '2')
  t.is(result[0].headers['x-c'], '3')
})

test('request, max headers count exceeded by one', async (t) => {
  const parser = new HTTPParser({ maxHeadersCount: 3 })

  const input = `GET /users HTTP/1.0\r
X-A: 1\r
X-B: 2\r
X-C: 3\r
X-D: 4\r
\r
`

  await t.exception(() => [...parser.push(input)], /HEADER_OVERFLOW/)
})

test('request, header value trailing whitespace trimmed', (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
X-Foo: bar   \r
X-Tab: baz\t\t\r
\r
`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers['x-foo'], 'bar')
  t.is(result[0].headers['x-tab'], 'baz')
})

test('request, control character in method rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GE'),
    Buffer.from([0x01]),
    Buffer.from('T / HTTP/1.0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, null byte in url rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /us'),
    Buffer.from([0x00]),
    Buffer.from('ers HTTP/1.0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, control character in url rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /us'),
    Buffer.from([0x01]),
    Buffer.from('ers HTTP/1.0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('response, control character in reason phrase rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('HTTP/1.1 200 O'),
    Buffer.from([0x00]),
    Buffer.from('K\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, duplicate host header rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: a.com\r
Host: b.com\r
Content-Length: 0\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('chunked response, chunk extension accepted', (t) => {
  const parser = new HTTPParser()

  const input =
    'HTTP/1.1 200 OK\r\n' +
    'Host: example.com\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    '\r\n' +
    '5;name=value\r\n' +
    'hello\r\n' +
    '0;final\r\n' +
    '\r\n'

  const result = [...parser.push(input)]

  t.is(result[0].type, RESPONSE)
  t.is(result[1].type, DATA)
  t.alike(result[1].data, Buffer.from('hello'))
  t.is(result[2].type, END)
})

test('chunked response, chunk extension with quoted value', (t) => {
  const parser = new HTTPParser()

  const input =
    'HTTP/1.1 200 OK\r\n' +
    'Host: example.com\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    '\r\n' +
    '5;name="value"\r\n' +
    'hello\r\n' +
    '0\r\n' +
    '\r\n'

  const result = [...parser.push(input)]

  t.is(result[0].type, RESPONSE)
  t.is(result[1].type, DATA)
  t.alike(result[1].data, Buffer.from('hello'))
  t.is(result[2].type, END)
})

test('chunked response, chunk extension with control character rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from(
      'HTTP/1.1 200 OK\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n5;name='
    ),
    Buffer.from([0x00]),
    Buffer.from('\r\nhello\r\n0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, method that nothing speaks is rejected', async (t) => {
  for (const method of ['FOO', 'get', 'Get', 'GETT', 'G']) {
    const parser = new HTTPParser()

    await t.exception(
      () => [...parser.push(method + ' / HTTP/1.1\r\nHost: example.com\r\n\r\n')],
      /INVALID_METHOD/,
      method + ' is refused'
    )
  }
})

test('request, every method that is spoken is parsed', (t) => {
  const methods = [
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
  ]

  for (const method of methods) {
    const parser = new HTTPParser()

    const result = [...parser.push(method + ' / HTTP/1.1\r\nHost: example.com\r\n\r\n')]

    t.is(result[0].method, method)
  }
})

test('request, slash in method name rejected', async (t) => {
  const parser = new HTTPParser()

  const input = 'G/T / HTTP/1.0\r\n\r\n'

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('response, slash only allowed after HTTP in first token', (t) => {
  const parser = new HTTPParser()

  const input = 'HTTP/1.1 200 OK\r\nHost: example.com\r\n\r\n'

  const result = [...parser.push(input)]

  t.is(result[0].type, RESPONSE)
  t.is(result[0].version, 'HTTP/1.1')
  t.is(result[0].code, 200)
})

test('chunked response, chunk extension exceeds header size limit', async (t) => {
  const parser = new HTTPParser({ maxHeaderSize: 64 })

  const input =
    'HTTP/1.1 200 OK\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    '\r\n' +
    '5;' +
    'x'.repeat(100) +
    '\r\n' +
    'hello\r\n' +
    '0\r\n' +
    '\r\n'

  await t.exception(() => [...parser.push(input)], /HEADER_OVERFLOW/)
})

test('response, invalid version rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/2.0 200 OK\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('response, HTTP/0.9 rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/0.9 200 OK\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, control character in version rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET / HTTP/1'),
    Buffer.from([0x01]),
    Buffer.from('1\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('drain, returns empty after full consumption', (t) => {
  const parser = new HTTPParser()

  const input = 'GET / HTTP/1.0\r\n\r\n'
  const result = [...parser.push(input)]

  t.is(result.length, 2)
  t.is(result[0].type, REQUEST)
  t.is(result[1].type, END)

  const remaining = parser.drain()
  t.alike(remaining, Buffer.alloc(0))
})

test('parser, remains fatal after a rejected header', async (t) => {
  const parser = new HTTPParser()

  // Resuming after the error would splice the two halves of the rejected name
  // back together and turn 'Content-Leng\0th' into a live 'Content-Length'.
  const input = Buffer.concat([
    Buffer.from('POST /users HTTP/1.1\r\nHost: example.com\r\nContent-Leng'),
    Buffer.from([0x00])
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
  await t.exception(() => [...parser.push('th: 5\r\n\r\nhello')], /INVALID_HEADER/)
})

test('parser, remains fatal after a rejected message', async (t) => {
  const parser = new HTTPParser()

  await t.exception(() => [...parser.push('GET /users HTTP/2.0\r\n\r\n')], /INVALID_MESSAGE/)
  await t.exception(
    () => [...parser.push('GET /users HTTP/1.0\r\n\r\n')],
    /INVALID_MESSAGE/,
    'a well formed message does not clear the error'
  )
})

test('request, empty content-length rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length:\r
\r
GET /admin HTTP/1.1\r
Host: example.com\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_CONTENT_LENGTH/)
})

test('request, empty transfer-encoding rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding:\r
Content-Length: 5\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID_MESSAGE/)
})

test('request, whitespace-only transfer-encoding rejected', async (t) => {
  const parser = new HTTPParser()

  const input =
    'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: \t \r\n' +
    'Content-Length: 5\r\n\r\nhello'

  await t.exception(() => [...parser.push(input)], /INVALID_MESSAGE/)
})

test('request, conflicting content-length and transfer-encoding rejected before the request is emitted', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 5\r
Transfer-Encoding: chunked\r
\r
`

  const result = []

  await t.exception(() => {
    for (const event of parser.push(input)) result.push(event)
  }, /INVALID_MESSAGE/)

  t.alike(result, [], 'a message that is about to be rejected is never surfaced')
})

test('request, http/1.0 with transfer-encoding rejected', async (t) => {
  const parser = new HTTPParser()

  const input = 'POST /users HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'

  await t.exception(() => [...parser.push(input)], /INVALID_MESSAGE/)
})

test('chunked request, chunk data emitted as it arrives', (t) => {
  const parser = new HTTPParser()

  t.is(
    [
      ...parser.push(
        'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n'
      )
    ].length,
    1
  )

  // Declare a chunk far larger than what follows. Holding the data back until
  // the whole chunk arrives would let a peer pin arbitrary memory.
  t.alike([...parser.push('100000\r\n')], [])
  t.alike([...parser.push('hello')], [{ type: DATA, data: Buffer.from('hello') }])
  t.alike([...parser.push('world')], [{ type: DATA, data: Buffer.from('world') }])
})

test('chunked request, chunk data and terminator split across pushes', (t) => {
  const parser = new HTTPParser()

  const input =
    'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n' +
    '5\r\nhello\r\n0\r\n\r\n'

  const result = []

  for (const byte of input) {
    for (const event of parser.push(byte)) result.push(event)
  }

  t.is(result.length, 7)
  t.is(result[0].type, REQUEST)
  t.alike(
    result.slice(1, 6).map((event) => event.data),
    [Buffer.from('h'), Buffer.from('e'), Buffer.from('l'), Buffer.from('l'), Buffer.from('o')]
  )
  t.is(result[6].type, END)
})

test('chunked request, chunk data longer than declared rejected', async (t) => {
  const parser = new HTTPParser()

  const input =
    'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n' +
    '2\r\nhello\r\n0\r\n\r\n'

  await t.exception(() => [...parser.push(input)], /INVALID_MESSAGE/)
})

test('chunked request, chunk extensions do not exhaust the header budget', (t) => {
  const parser = new HTTPParser()

  ;[
    ...parser.push(
      'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n'
    )
  ]

  // The header budget is spent per message, so a long lived stream that carries
  // an extension on every chunk must not run out of it.
  let count = 0

  for (let i = 0; i < 5000; i++) {
    for (const event of parser.push('1;name=value\r\nx\r\n')) {
      if (event.type === DATA) count++
    }
  }

  t.is(count, 5000)
})

test('chunked request, trailer fields accepted', (t) => {
  const parser = new HTTPParser()

  const input =
    'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n' +
    '5\r\nhello\r\n0\r\nX-Checksum: abc\r\nX-Trace: 1\r\n\r\n'

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.alike(result[1], { type: DATA, data: Buffer.from('hello') })
  t.is(result[2].type, END)
  t.is(result.length, 3)
})

test('chunked request, trailer with framing header rejected', async (t) => {
  const parser = new HTTPParser()

  const input =
    'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n' +
    '0\r\nContent-Length: 5\r\n\r\n'

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('chunked request, trailer with control character rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from(
      'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Trace: '
    ),
    Buffer.from([0x00]),
    Buffer.from('\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('chunked request, trailers count towards max headers count', async (t) => {
  const parser = new HTTPParser({ maxHeadersCount: 3 })

  const input =
    'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n' +
    '0\r\nX-A: 1\r\nX-B: 2\r\n\r\n'

  await t.exception(() => [...parser.push(input)], /Header count exceeds limit/)
})

test('response, no content-length or transfer-encoding is framed by end of stream', (t) => {
  const parser = new HTTPParser()

  const result = [...parser.push('HTTP/1.1 200 OK\r\n\r\n')]

  t.is(result.length, 1)
  t.is(result[0].type, RESPONSE)

  // Treating the missing framing as an empty body would turn the body into the
  // next response.
  t.alike([...parser.push('hello ')], [{ type: DATA, data: Buffer.from('hello ') }])
  t.alike([...parser.push('world')], [{ type: DATA, data: Buffer.from('world') }])

  // Only the connection closing can terminate the message.
  t.alike([...parser.end()], [{ type: END }])
  t.alike(parser.drain(), Buffer.alloc(0))
})

test('response, skip body for head response', (t) => {
  const parser = new HTTPParser()

  parser.skipBody()

  const input = `HTTP/1.1 200 OK\r
Content-Length: 100\r
\r
HTTP/1.1 204 No Content\r
\r
`

  const result = [...parser.push(input)]

  t.is(result.length, 4)
  t.is(result[0].code, 200)
  t.is(result[1].type, END)
  t.is(result[2].code, 204)
  t.is(result[3].type, END)
})

test('response, skip body applies to a single response', (t) => {
  const parser = new HTTPParser()

  parser.skipBody()

  const input = `HTTP/1.1 200 OK\r
Content-Length: 3\r
\r
HTTP/1.1 200 OK\r
Content-Length: 3\r
\r
abc`

  const result = [...parser.push(input)]

  t.is(result.length, 5)
  t.is(result[1].type, END)
  t.alike(result[3], { type: DATA, data: Buffer.from('abc') })
})

test('response, informational response has no body', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 100 Continue\r
Content-Length: 5\r
\r
HTTP/1.1 200 OK\r
Content-Length: 2\r
\r
hi`

  const result = [...parser.push(input)]

  t.is(result[0].code, 100)
  t.is(result[1].type, END)
  t.is(result[2].code, 200)
  t.alike(result[3], { type: DATA, data: Buffer.from('hi') })
  t.is(result[4].type, END)
})

test('response, 204 has no body', (t) => {
  const parser = new HTTPParser()

  const result = [...parser.push('HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\n')]

  t.is(result.length, 2)
  t.is(result[0].code, 204)
  t.is(result[1].type, END)
})

test('response, 304 with content-length has no body', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 304 Not Modified\r
Content-Length: 5\r
\r
HTTP/1.1 200 OK\r
Content-Length: 0\r
\r
`

  const result = [...parser.push(input)]

  t.is(result.length, 4)
  t.is(result[0].code, 304)
  t.is(result[2].code, 200)
})

test('response, status line without reason phrase', (t) => {
  const parser = new HTTPParser()

  const result = [...parser.push('HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n')]

  t.is(result[0].type, RESPONSE)
  t.is(result[0].code, 200)
  t.is(result[0].reason, '')
})

test('response, status code with leading zeros rejected', async (t) => {
  const parser = new HTTPParser()

  await t.exception(() => [...parser.push('HTTP/1.1 0200 OK\r\n\r\n')], /INVALID_MESSAGE/)
})

test('response, status code with fewer than three digits rejected', async (t) => {
  const parser = new HTTPParser()

  await t.exception(() => [...parser.push('HTTP/1.1 20 OK\r\n\r\n')], /INVALID_MESSAGE/)
})

test('request, connect enters a tunnel', (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'),
    Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05])
  ])

  const result = [...parser.push(input)]

  t.is(result.length, 2)
  t.is(result[0].method, 'CONNECT')
  t.is(result[1].type, END)

  // The tunnelled bytes are not ours to parse and must survive intact.
  t.alike(parser.drain(), Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05]))
})

test('response, 101 enters a tunnel', (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n'),
    Buffer.from([0x81, 0x05])
  ])

  const result = [...parser.push(input)]

  t.is(result.length, 2)
  t.is(result[0].code, 101)
  t.is(result[1].type, END)

  t.alike(parser.drain(), Buffer.from([0x81, 0x05]))
})

test('push, empty buffer before a message', (t) => {
  const parser = new HTTPParser()

  t.alike([...parser.push(Buffer.alloc(0))], [])

  const result = [...parser.push('GET /users HTTP/1.0\r\n\r\n')]

  t.is(result[0].type, REQUEST)
  t.is(result[0].url, '/users')
})

test('push, empty buffer within a message', (t) => {
  const parser = new HTTPParser()

  const result = []

  for (const chunk of ['GET /users HTT', '', Buffer.alloc(0), 'P/1.0\r\n\r\n']) {
    for (const event of parser.push(chunk)) result.push(event)
  }

  t.is(result[0].type, REQUEST)
  t.is(result[0].url, '/users')
  t.is(result[1].type, END)
})

test('request, long header value with a large max header size', (t) => {
  const parser = new HTTPParser({ maxHeaderSize: 1024 * 1024 })

  const value = 'a'.repeat(256 * 1024)

  const result = [...parser.push(`GET / HTTP/1.0\r\nX-Large: ${value}\r\n\r\n`)]

  t.is(result[0].headers['x-large'], value)
})

test('end, rejects a truncated body', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /upload HTTP/1.1\r
Host: example.com\r
Content-Length: 11\r
\r
hello`

  const result = [...parser.push(input)]

  t.is(result.length, 2)
  t.alike(result[1], { type: DATA, data: Buffer.from('hello') })

  await t.exception(() => [...parser.end()], /Message truncated/)

  // The truncated message must not be resumed by a later push.
  await t.exception(
    () => [...parser.push('GET /next HTTP/1.1\r\nHost: example.com\r\n\r\n')],
    /Message truncated/
  )
})

test('end, rejects a truncated head', async (t) => {
  const parser = new HTTPParser()

  t.alike([...parser.push('GET /users HTTP/1.1\r\nHost: exa')], [])

  await t.exception(() => [...parser.end()], /Message truncated/)
})

test('end, rejects a truncated chunked body', async (t) => {
  const parser = new HTTPParser()

  const input =
    'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel'

  t.is([...parser.push(input)].length, 2)

  await t.exception(() => [...parser.end()], /Message truncated/)
})

test('end, yields nothing after a complete message', (t) => {
  const parser = new HTTPParser()

  t.is([...parser.push('GET /users HTTP/1.0\r\n\r\n')].length, 2)
  t.alike([...parser.end()], [])
})

test('end, yields nothing after a tunnel', (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'),
    Buffer.from([0x16, 0x03])
  ])

  t.is([...parser.push(input)].length, 2)
  t.alike([...parser.end()], [])
  t.alike(parser.drain(), Buffer.from([0x16, 0x03]))
})

test('request, every token byte accepted in a header name', (t) => {
  const parser = new HTTPParser()

  // RFC 9110 tchar, which the token table is written out by hand to match.
  const name = "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyz"

  const result = [
    ...parser.push(`GET / HTTP/1.0\r\n${name.toUpperCase()}: value\r\n${name}: value\r\n\r\n`)
  ]

  t.is(result[0].headers[name], 'value, value')
})

test('request, obs-text in header name rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET / HTTP/1.0\r\nX-'),
    Buffer.from([0x80]),
    Buffer.from(': value\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, obs-text in header value accepted', (t) => {
  const parser = new HTTPParser()

  // RFC 9110 `field-vchar` covers `obs-text`, and a field value carrying a byte
  // from 0x80 to 0xff is ordinary enough traffic that refusing it would turn a
  // request every other implementation accepts into a 400. Each byte surfaces
  // as the character of the same value, which is how Node.js surfaces it too.
  const input = Buffer.concat([
    Buffer.from('GET / HTTP/1.0\r\nX-Name: caf'),
    Buffer.from([0xe9]),
    Buffer.from('\r\n\r\n')
  ])

  const result = [...parser.push(input)]

  t.is(result[0].headers['x-name'], 'caf\xe9')
})

test('response, obs-text in reason phrase accepted', (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('HTTP/1.1 200 caf'),
    Buffer.from([0xe9]),
    Buffer.from('\r\nContent-Length: 0\r\n\r\n')
  ])

  const result = [...parser.push(input)]

  t.is(result[0].reason, 'caf\xe9')
})

test('request, obs-text in url rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /us'),
    Buffer.from([0x80]),
    Buffer.from('ers HTTP/1.0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_MESSAGE/)
})

test('request, obs-fold continuation line rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `GET / HTTP/1.0\r
X-Name: first\r
 second\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, bare lf rejected', async (t) => {
  const parser = new HTTPParser()

  await t.exception(
    () => [...parser.push('GET / HTTP/1.0\nHost: example.com\n\n')],
    /INVALID_MESSAGE/
  )
})

test('request, leading crlf before request line rejected', async (t) => {
  const parser = new HTTPParser()

  await t.exception(() => [...parser.push('\r\nGET / HTTP/1.0\r\n\r\n')], /INVALID_MESSAGE/)
})

test('request, duplicate content-length with differing case rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 5\r
content-length: 5\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /Duplicate header/)
})

test('request, pipelined requests', (t) => {
  const parser = new HTTPParser()

  const input = `GET /a HTTP/1.1\r
Host: example.com\r
\r
GET /b HTTP/1.1\r
Host: example.com\r
\r
`

  const result = [...parser.push(input)]

  t.is(result.length, 4)
  t.is(result[0].url, '/a')
  t.is(result[2].url, '/b')
})

// A cookie carries the commas that would otherwise separate the elements inside
// its own value, so a folded `Set-Cookie` could never be taken apart again.
test('response, set-cookie is kept as a list', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 200 OK\r
Set-Cookie: session=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly\r
Set-Cookie: theme=dark; Path=/\r
Content-Length: 0\r
\r
`

  const result = [...parser.push(input)]

  t.alike(result[0].headers['set-cookie'], [
    'session=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly',
    'theme=dark; Path=/'
  ])
})

test('response, a lone set-cookie is a list too', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 200 OK\r
Set-Cookie: session=abc\r
Content-Length: 0\r
\r
`

  const result = [...parser.push(input)]

  t.alike(result[0].headers['set-cookie'], ['session=abc'])
})

test('request, cookie is folded onto one line', (t) => {
  const parser = new HTTPParser()

  const input = `GET /a HTTP/1.1\r
Host: example.com\r
Cookie: session=abc\r
Cookie: theme=dark\r
\r
`

  const result = [...parser.push(input)]

  // Unlike `Set-Cookie`, `Cookie` may only appear once and its own separator is
  // `; `, so the elements are folded back onto the one line they belong on.
  t.is(result[0].headers.cookie, 'session=abc; theme=dark')
})

test('response, set-cookie does not leak into the next message', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 200 OK\r
Set-Cookie: a=1\r
Content-Length: 0\r
\r
HTTP/1.1 200 OK\r
Set-Cookie: b=2\r
Content-Length: 0\r
\r
`

  const result = [...parser.push(input)]

  t.alike(result[0].headers['set-cookie'], ['a=1'])
  t.alike(result[2].headers['set-cookie'], ['b=2'])
})
